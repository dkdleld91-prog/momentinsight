// C 30일 순위(쿠팡) 수집기 플랫폼 정적 검사(명세 §9.9, §2.1·§2.2-3·4·5). 파일을 읽기만 한다.
// zsh·plutil·pwsh·PowerShell 을 실행하지 않는다(Vercel 리눅스 빌드에서도 돈다, 낮음 6).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COLLECTOR_TOKEN_PATTERN, PUBLIC_ORIGIN, TOKEN_ENV,
} from "../tools/coupang-rank-collector/lib/contract.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectorRoot = path.join(repoRoot, "tools", "coupang-rank-collector");
const read = (relative) => fs.readFileSync(path.join(collectorRoot, relative), "utf8");
const readBytes = (relative) => fs.readFileSync(path.join(collectorRoot, relative));

const LIB_FILES = fs.readdirSync(path.join(collectorRoot, "lib")).filter((name) => name.endsWith(".mjs")).sort().map((name) => `lib/${name}`);
const ENTRY_FILES = ["worker.mjs", "trial.mjs"];
const CODE_FILES = [...LIB_FILES, ...ENTRY_FILES];
const PS_FILES = ["platform/windows/install-windows.ps1", "platform/windows/run-worker.ps1"];
const MAC_INSTALLER = "platform/macos/install-macos.sh";
const MAC_FILES = [MAC_INSTALLER, "platform/macos/run-worker.sh", "platform/macos/collector.plist.template"];
const SHIPPED = [...CODE_FILES, ...PS_FILES, ...MAC_FILES];

// §2.2-3: 수집기 lib·worker·PS 스크립트(여기서는 맥 파일까지)에 하나도 없어야 하는 문자열
const N30_FORBIDDEN = [
  ["chrome.exe", /chrome\.exe/i],
  ["Get-Process chrome", /Get-Process\s+(?:-Name\s+)?["']?chrome/i],
  ["Stop-Process -Name", /Stop-Process\s+-Name/i],
  ["taskkill /IM", /taskkill(?:\.exe)?\W+\/IM\b|["']\/IM["']/i],
  ["NaverShopping", /NaverShopping/i],
  ["NativeMessagingHosts", /NativeMessagingHosts/i],
  ["naver-shopping-native-host", /naver-shopping-native-host/i],
];
// §2.2-3(M8): N30 로그 경로·plist 라벨 문자열. 맥 설치기(collector.json 에 쓰는 곳)에서만 허용
const N30_LOG_LABEL = [/naver-shopping-chrome-scheduler/i, /mi-rank-watchdog/i, /rank-watchdog/i];
// §2.2-4: 맥 C 코드에 없어야 하는 것
const MAC_FORBIDDEN = [/\bpkill\b/i, /\bkillall\b/i, /\bosascript\b/i, /quit\s+app/i];
const N30_LABELS = ["co.kr.momentinsight.naver-shopping-chrome-scheduler", "co.kr.momentinsight.rank-watchdog"];

test(".ps1 은 ASCII 만(BOM 없음)", () => {
  for (const file of PS_FILES) {
    const bytes = readBytes(file);
    const offending = [...bytes].findIndex((byte) => byte > 0x7f);
    assert.equal(offending, -1, `${file}: non-ASCII byte at ${offending}`);
  }
});

test("§2.2-3 금지 문자열 0개(lib·worker·trial·PS·맥 파일)", () => {
  for (const file of SHIPPED) {
    const text = read(file);
    for (const [label, pattern] of N30_FORBIDDEN) assert.doesNotMatch(text, pattern, `${file}: ${label}`);
  }
});

test("N30 로그 경로·라벨 문자열은 맥 설치기에서만(lib·worker·trial·run-worker.*·PS 0개)", () => {
  for (const file of SHIPPED.filter((item) => item !== MAC_INSTALLER)) {
    const text = read(file);
    for (const pattern of N30_LOG_LABEL) assert.doesNotMatch(text, pattern, `${file}: ${pattern}`);
  }
  const installer = read(MAC_INSTALLER);
  assert.match(installer, /Library\/Logs\/MomentInsight\/naver-shopping-chrome-scheduler\.log/);
  assert.match(installer, /Library\/Logs\/MomentInsight\/mi-rank-watchdog\.log/);
  // 경로는 collector.json(chromeGuard)에만 쓰고, 그 밖의 줄에서 쓰지 않는다.
  const uses = installer.split("\n").filter((line) => /N30_(?:SCHEDULER|WATCHDOG)_LOG/.test(line));
  assert.equal(uses.length, 3, uses.join("\n"));
  assert.ok(uses.every((line) => /^N30_(?:SCHEDULER|WATCHDOG)_LOG=/.test(line) || /"\$NODE" -e "\$CONFIG_JS"/.test(line)));
});

test("§2.2-4 맥: pkill·killall·osascript·quit app 없음, N30 라벨에 launchctl 없음", () => {
  for (const file of SHIPPED) {
    const text = read(file);
    for (const pattern of MAC_FORBIDDEN) assert.doesNotMatch(text, pattern, `${file}: ${pattern}`);
    for (const label of N30_LABELS) assert.ok(!text.includes(label), `${file}: ${label}`);
  }
  for (const file of MAC_FILES) {
    for (const line of read(file).split("\n")) {
      if (!/launchctl/.test(line)) continue;
      assert.doesNotMatch(line, /naver|watchdog|rank-watchdog/i, `${file}: ${line}`);
      assert.ok(/\$LABEL|\$TRIAL_AGENT|launchctl print gui\/\$UID_NUM\/\$TRIAL_AGENT|launchctl bootstrap|^\s*#/.test(line), `${file}: ${line}`);
    }
  }
  // 맥 시험 에이전트(예외)는 설치기에서 확인·안내만 한다(bootout 은 안내 문구로만).
  const installer = read(MAC_INSTALLER);
  assert.match(installer, /TRIAL_AGENT="com\.momentinsight\.coupang-trial"/);
  const trialLines = installer.split("\n").filter((line) => line.includes("$TRIAL_AGENT") && /launchctl/.test(line));
  assert.ok(trialLines.every((line) => /launchctl print|info "launchctl bootout/.test(line)), trialLines.join("\n"));
  // kill 은 우리 표식으로 고른 PID 에만(TERM → KILL).
  const kills = installer.split("\n").filter((line) => /\bkill\b/.test(line) && !/^\s*#/.test(line));
  assert.ok(kills.length >= 2);
  assert.ok(kills.every((line) => /kill -(?:TERM|KILL) "\$pid"/.test(line)), kills.join("\n"));
  for (const marker of ['RUNS_MARKER="/MomentInsight/CoupangRank/runs/"', 'WORKER_MARKER="/CoupangRank/app/worker.mjs"', 'TRIAL_MARKER="/CoupangRank/app/trial.mjs"']) {
    assert.ok(installer.includes(marker), marker);
  }
});

test("윈도우 설치기 필수 문자열(§9.5.2): headless 실행·Limited·대화형·IgnoreNew·우선순위 7·시간 제한·DPAPI·UTF-8 받기", () => {
  const installer = read("platform/windows/install-windows.ps1");
  for (const needle of [
    "conhost.exe", "--headless", "IgnoreNew", "-RunLevel Limited", "-LogonType Interactive",
    "co.kr.momentinsight.coupang-rank-collector.v1", "Add-Type -AssemblyName System.Security",
    "DownloadData", "[System.Text.Encoding]::UTF8.GetString($raw)", "[System.Text.Encoding]::UTF8.GetBytes([string]$f.content)",
    "[System.Security.Cryptography.ProtectedData]::Protect(", "DataProtectionScope]::CurrentUser", "ZeroFreeBSTR",
    "Read-Host -AsSecureString", "$ProgressPreference = 'SilentlyContinue'", "$ErrorActionPreference = 'Stop'",
    "[System.Management.Automation.Language.Parser]::ParseFile", "'--check'", "SetAccessRuleProtection($true, $false)",
    "New-TimeSpan -Minutes 10", "New-TimeSpan -Days 3650", "-AtLogOn", "PT2M", "-StartWhenAvailable", "-AllowStartIfOnBatteries",
    "-DontStopIfGoingOnBatteries", "'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe'", ".Trim().Trim('\"').Trim()",
    "VersionInfo.ProductVersion", "MI_COUPANG_INSTALL_OK", "MI_COUPANG_INSTALL_FAIL", "MI_COUPANG_UNINSTALL_OK",
    "release_mismatch", "edge_not_found", "node_version_must_be_22_to_24", "powershell_51_admin_required", "--hello-only",
    "\\MomentInsight\\CoupangRank\\runs\\", "\\CoupangRank\\app\\worker.mjs", "\\CoupangRank\\app\\trial.mjs",
  ]) {
    assert.ok(installer.includes(needle), needle);
  }
  assert.ok(installer.split("-Priority 7").length - 1 >= 2, "-Priority 7: 설치·시험 작업 둘 다");
  assert.ok(installer.includes("-ExecutionTimeLimit (New-TimeSpan -Minutes 15) -Priority 7"));
  assert.ok(installer.includes("-ExecutionTimeLimit (New-TimeSpan -Minutes 45) -Priority 7"));
  assert.ok(installer.includes("$TaskPath = '\\MomentInsight\\'"));
  assert.ok(installer.includes("$TaskName = 'CoupangRank'"));
  assert.ok(installer.includes("$TrialTaskName = 'CoupangRankTrial'"));
  assert.ok(installer.includes("Join-Path $env:LOCALAPPDATA 'MomentInsight\\CoupangRank'"));
  // 금지: SYSTEM·로그온 안 해도 실행·관리자 권한 작업·Invoke-WebRequest 의 .Content 로 묶음 받기
  assert.doesNotMatch(installer, /-RunLevel\s+Highest|S4U|-LogonType\s+Password|NT AUTHORITY|UserId\s+["']?SYSTEM/i);
  assert.doesNotMatch(installer, /Invoke-WebRequest|\biwr\b|\.Content\b/);
  // Stop-Process 는 -Id 로만, 고르는 기준은 명령줄 표식
  const stops = installer.split("\n").filter((line) => /Stop-Process/.test(line));
  assert.ok(stops.length >= 2);
  assert.ok(stops.every((line) => /Stop-Process -Id \$process\.ProcessId -Force/.test(line)), stops.join("\n"));
  assert.match(installer, /Get-CimInstance Win32_Process -Filter "Name='msedge\.exe'"/);
  assert.match(installer, /Get-CimInstance Win32_Process -Filter "Name='node\.exe'"/);
});

test("run-worker.ps1(§9.5.3): System.Security 싣기·collector.json 은 ReadAllText+UTF8·BOM 제거·DPAPI 복호·환경변수 지움·늘 exit 0", () => {
  const runner = read("platform/windows/run-worker.ps1");
  for (const needle of [
    "Add-Type -AssemblyName System.Security", "[System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)",
    "[char]0xFEFF", "ConvertFrom-Json", "[System.Security.Cryptography.ProtectedData]::Unprotect(",
    "co.kr.momentinsight.coupang-rank-collector.v1", "dpapi_unprotect_failed", `$env:${TOKEN_ENV} = $plainToken`,
    `Remove-Item -Path 'Env:\\${TOKEN_ENV}'`, "worker.mjs", "trial.mjs", "exit 0",
  ]) {
    assert.ok(runner.includes(needle), needle);
  }
  assert.doesNotMatch(runner, /Get-Content/i, "PS 5.1 Get-Content 는 BOM 없는 UTF-8 을 CP949 로 읽는다");
  assert.doesNotMatch(runner, /exit [1-9]/);
});

test("PS 두 파일의 Edge 경로 규칙·연결 코드 형식이 계약과 같다", () => {
  const edgeRule = "'\\\\Microsoft\\\\Edge\\\\Application\\\\msedge\\.exe$'";
  for (const file of PS_FILES) assert.ok(read(file).includes(edgeRule), `${file}: ${edgeRule}`);
  assert.ok(read("platform/windows/install-windows.ps1").includes(`$TokenPattern = '${COLLECTOR_TOKEN_PATTERN.source}'`));
  assert.ok(read(MAC_INSTALLER).includes(`TOKEN_RE='${COLLECTOR_TOKEN_PATTERN.source}'`));
  for (const file of ["platform/windows/install-windows.ps1", MAC_INSTALLER]) {
    const text = read(file);
    assert.ok(text.includes(`${PUBLIC_ORIGIN}/coupang-collector/bundle.json`), `${file}: bundle url`);
    assert.doesNotMatch(text.replaceAll(PUBLIC_ORIGIN, ""), /https?:\/\/(?!www\.apple\.com\/DTDs)/, `${file}: 다른 도메인`);
  }
});

test("맥 설치기·래퍼·plist(§9.6): 키체인·라벨·launchd 설정·Edge 우선", () => {
  const installer = read(MAC_INSTALLER);
  for (const needle of [
    "#!/bin/zsh", "set -euo pipefail", "umask 077", 'LABEL="co.kr.momentinsight.coupang-rank-collector"',
    'SERVICE="co.kr.momentinsight.coupang-rank-collector"', '"$HOME/Library/Application Support/MomentInsight/CoupangRank"',
    '/usr/bin/security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -T /usr/bin/security -w',
    '/usr/bin/security delete-generic-password -s "$SERVICE" -a "$ACCOUNT"', "(( EUID != 0 )) || fail run_as_user",
    "fail trial_agent_loaded", "fail browser_app_required", '"/Applications/Microsoft Edge.app"', '"$HOME/Applications/Microsoft Edge.app"',
    "Edge 설치를 권장합니다(N30 크롬과 완전 분리)", '/bin/launchctl bootstrap "gui/$UID_NUM" "$PLIST"',
    '/bin/launchctl kickstart -k "gui/$UID_NUM/$LABEL"', "--hello-only", '/bin/zsh -n "$ROOT/app.new/run-worker.sh"',
    "MI_COUPANG_INSTALL_OK", "MI_COUPANG_UNINSTALL_OK", "guard=$GUARD", "agent=$AGENT_STATE",
  ]) {
    assert.ok(installer.includes(needle), needle);
  }
  // 연결 코드 원문을 명령줄·화면에 내지 않는다(-w 는 맨 끝, 값 없이).
  const addLines = installer.split("\n").filter((line) => line.includes("add-generic-password"));
  assert.equal(addLines.length, 1);
  assert.match(addLines[0], /-w(?:\s*$|\s+\|\|)/);
  assert.doesNotMatch(installer, /print[^\n]*\$(?:CHECK_TOKEN|HELLO_TOKEN)/);
  const wrapper = read("platform/macos/run-worker.sh");
  for (const needle of [
    "#!/bin/zsh", "set -euo pipefail", "umask 077", 'ROOT="${0:A:h:h}"', 'NODE="$(<"$ROOT/node-path")"',
    "/usr/bin/security find-generic-password -s co.kr.momentinsight.coupang-rank-collector -a \"$ACCOUNT\" -w",
    `${TOKEN_ENV}="$TOKEN" exec "$NODE" "$ROOT/app/worker.mjs"`, "token_missing",
  ]) {
    assert.ok(wrapper.includes(needle), needle);
  }
  const plist = read("platform/macos/collector.plist.template");
  for (const needle of [
    "<key>Label</key><string>co.kr.momentinsight.coupang-rank-collector</string>",
    "<string>/bin/zsh</string><string>{ROOT}/app/run-worker.sh</string>",
    "<key>StartInterval</key><integer>600</integer>", "<key>RunAtLoad</key><false/>", "<key>Nice</key><integer>5</integer>",
    "<key>ExitTimeOut</key><integer>30</integer>", "<string>{ROOT}/logs/launchd.log</string>",
  ]) {
    assert.ok(plist.includes(needle), needle);
  }
  assert.ok(!plist.includes("ProcessType"));
});

test("guards.mjs: N30 로그는 \"r\" 로만 열고 쓰지 않으며, pgrep -x 와 ps -o command= 만 쓴다", () => {
  const guards = read("lib/guards.mjs");
  const opens = guards.match(/openSync\([^)]*\)/g) || [];
  assert.ok(opens.length >= 1);
  assert.ok(opens.every((call) => /openSync\(\s*file\s*,\s*"r"\s*\)/.test(call)), opens.join(" "));
  assert.doesNotMatch(guards, /writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync|renameSync|truncate|utimes|process\.kill|spawn\(/);
  assert.ok(guards.includes('run("/usr/bin/pgrep", ["-x", "Google Chrome"])'));
  assert.ok(guards.includes('run("/bin/ps", ["-o", "command=", "-p", pid])'));
});

test("§2.1 경계: lib 는 node:* 와 lib 안 상대 경로만, worker·trial 은 node:* 와 ./lib/ 만, 테스트도 폴더 안만", () => {
  const importPattern = /(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  const specifiers = (text) => [...text.matchAll(importPattern)].map((match) => match[1] || match[2]);
  for (const file of LIB_FILES) {
    for (const spec of specifiers(read(file))) assert.match(spec, /^(?:node:[a-z_/]+|\.\/[a-z-]+\.mjs)$/, `${file}: ${spec}`);
    assert.doesNotMatch(read(file), /import\(/, `${file}: dynamic import`);
  }
  for (const file of ENTRY_FILES) {
    for (const spec of specifiers(read(file))) assert.match(spec, /^(?:node:[a-z_/]+|\.\/lib\/[a-z-]+\.mjs)$/, `${file}: ${spec}`);
  }
  for (const name of fs.readdirSync(path.join(collectorRoot, "test")).filter((item) => item.endsWith(".mjs"))) {
    for (const spec of specifiers(read(`test/${name}`))) {
      assert.match(spec, /^(?:node:[a-z_/]+|\.\.\/lib\/[a-z-]+\.mjs|\.\.\/(?:worker|trial)\.mjs|\.\/helpers\.mjs)$/, `test/${name}: ${spec}`);
    }
  }
  // trial 은 서버를 부르지 않는다.
  assert.doesNotMatch(read("trial.mjs"), /api\.mjs|fetch\(/);
});

test("폴더: package.json·node_modules 없음, 파일 이름에 naver-shopping-native-host 없음", () => {
  const names = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      names.push(path.relative(collectorRoot, path.join(dir, entry.name)));
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  };
  walk(collectorRoot);
  assert.ok(!names.some((name) => /(^|\/)(package\.json|package-lock\.json|node_modules)$/.test(name)), names.join(","));
  assert.ok(!names.some((name) => /naver-shopping-native-host/i.test(name)));
  for (const file of SHIPPED) assert.ok(names.includes(file), file);
});

test("토큰: worker 는 시작 즉시 환경에서 지우고, 브라우저에는 MI_ 를 뺀 환경만, 머리글은 x-mi-coupang-collector 하나", () => {
  const worker = read("worker.mjs");
  const tokenRead = worker.indexOf("const rawToken = env[TOKEN_ENV];");
  const tokenDelete = worker.indexOf("delete env[TOKEN_ENV];");
  assert.ok(tokenRead > 0 && tokenDelete > tokenRead);
  assert.ok(tokenDelete < worker.indexOf("d.createLogger("), "기록기를 만들기 전에 지운다");
  assert.doesNotMatch(worker, /console\.(?:log|error)\([^)]*token/i);
  const browser = read("lib/browser.mjs");
  assert.ok(browser.includes("env: cleanEnv(env)"));
  assert.ok(browser.includes('key.toUpperCase().startsWith("MI_")'));
  const api = read("lib/api.mjs");
  assert.deepEqual([...api.matchAll(/x-mi-[a-z-]+/g)].map((match) => match[0]), []);
  assert.ok(api.includes("[COLLECTOR_VERSION_HEADER]: COLLECTOR_VERSION"));
  assert.ok(api.includes('redirect: "error"'));
});

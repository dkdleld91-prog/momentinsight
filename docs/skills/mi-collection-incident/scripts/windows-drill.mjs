#!/usr/bin/env node
// 윈도우 주작업기 훈련 한 줄(Windows PowerShell 5.1, 관리자) 생성·검사 — 2026-09-29 3차 훈련 후속(1.1.34 D).
//   node windows-drill.mjs [정지초=900] [중심초=25] [반폭=7] [catch-up 분 끝자리=4, 끄기=-1]   (DRY=1 이면 시험 모드)
//   node windows-drill.mjs restore          — 창을 닫아 finally 가 못 돈 경우의 복구 전용 한 줄
//   node windows-drill.mjs check <파일>     — 한 줄 파일의 PS 5.1 구조 검사(한 줄·괄호·-and/-or 혼용·PS7 전용 연산자)
//   node windows-drill.mjs phase [시간=2]   — 제외 위상 측정(서버 기록 읽기 전용) → 인자 추천, 불안정하면 exit 3
// 09-29 훈련은 수집 도중 크롬·호스트를 죽여 임대가 35분 남았다(F1). 이 한 줄은 호스트가 한가할 때만 멈추고,
// 정지초가 지나면 finally 에서 예약 작업을 되살린다. Ctrl+C 뒤에도 finally 가 되살리도록 짰지만 PS 5.1 실기에서는 확인하지 않았다
// (DRY 는 Enable/Disable/Start/Stop 을 돌리지 않는다) → DRILL_RESTORED 가 안 보이면 복구 한 줄. 모든 줄은 출력 전에 checkPowerShell51Line 을 통과해야 한다.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { fileURLToPath } from "node:url";

// 윈도우 업데이터(scripts/windows/update-naver-shopping-chrome-extension.ps1)가 멈추는 대상과 같다(테스트가 대조).
export const TASK_PATH = "\\MomentInsight\\";
export const TASK_NAME = "NaverShoppingChrome";
export const HOST_LAUNCHER = "MomentInsightNaverShoppingHost.exe";
export const HOST_SCRIPT = "naver-shopping-native-host.mjs";
// 한가함 = 호스트 프로세스가 12초 연속 없음. 확장은 수집 중 들어온 알람을 미뤄 두었다가 앞 런이 끝나고 6초 뒤
// (service-worker.js PENDING_TRIGGER_HANDOFF_MS) 다음 연결을 연다 → 6초 + CIM 조회·0.5초 폴링 여유 4초 이상.
export const IDLE_SECONDS = 12;
export const WAIT_MINUTES = 45;
// 기본 정지 900초 = 대기기 인계 180초(p_primary_stale_seconds) + 맥 catch-up 한 주기(기본 10분, 후보 6분 중 긴 쪽)
// + 한 런 여유 120초. 이보다 짧으면 맥 대기기가 인계해 커밋하는 것을 보기 전에 윈도우가 돌아온다(테스트가 대조).
export const RUN_MARGIN_SECONDS = 120;
export const DRILL_DEFAULTS = Object.freeze({ seconds: 900, center: 25, halfWidth: 7, catchUpDigit: 4 });

const HOST_FILTER = `$f="Name='node.exe' OR Name='${HOST_LAUNCHER}'";`;
const HOST_WHERE = `Where-Object { ($_.Name -ne 'node.exe') -or ($_.CommandLine -like '*${HOST_SCRIPT}*') }`;
const TASK_VARS = `$tp="${TASK_PATH}"; $tn="${TASK_NAME}";`;
const TASK_ARGS = "-TaskPath $tp -TaskName $tn";

function drillTemplate() {
  return [
    `$dry=@DRY@; $sec=@SEC@; $c=@C@; $w=@W@; $cm=@CM@; $im=${IDLE_SECONDS}; ${TASK_VARS} ${HOST_FILTER}`,
    // 호스트 수. CIM 조회가 실패하면 99(= 바쁨)라 멈추지 않는다.
    `function Busy { try { @(Get-CimInstance Win32_Process -Filter $f -ErrorAction Stop | ${HOST_WHERE}).Count } catch { 99 } };`,
    // 크롬 본체(--type= 없는 프로세스)가 120초 안에 시작됐으면 재시작 직후 catch-up(+8초 실측)이 곧 뜬다.
    "function Young { @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" -ErrorAction SilentlyContinue | Where-Object { ($_.CommandLine -notlike '*--type=*') -and ($_.CreationDate -gt (Get-Date).AddSeconds(-120)) }).Count -gt 0 };",
    "$dis=$false;",
    "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host \"DRILL_NEEDS_ADMIN\" }",
    `elseif ($dry) { $dis=$true } else { try { Disable-ScheduledTask ${TASK_ARGS} -ErrorAction Stop | Out-Null; $dis=$true } catch { Write-Host "DRILL_DISABLE_FAILED $($_.Exception.Message)" } };`,
    "if ($dis) { try {",
    `Write-Host "DRILL_WAITING $(Get-Date -Format HH:mm:ss) max=${WAIT_MINUTES}m idle=$($im)s";`,
    `$last=Get-Date; $until=(Get-Date).AddMinutes(${WAIT_MINUTES}); $go=$false; $idle=0;`,
    "while ((Get-Date) -lt $until) { if ((Busy) -gt 0) { $last=Get-Date };",
    // 시각 조건: 초가 rank-remote 창(중심 ± 반폭, 60 경계를 넘는 원형 거리) 밖, 08:58~09:02·14:58~15:02 밖(rank-0900/1500 은 hh:00:01),
    // catch-up 분(그 분 전체와 앞 분 50초~) 밖. 마지막 항은 새로 잰 호스트 수(-and 는 왼쪽부터 평가하므로 가장 늦게 잰다).
    "$n=Get-Date; $s=$n.Second; $d=[Math]::Abs($s - $c); if ($d -gt 30) { $d=60 - $d };",
    "$fix=((($n.Hour -eq 8) -or ($n.Hour -eq 14)) -and ($n.Minute -ge 58)) -or ((($n.Hour -eq 9) -or ($n.Hour -eq 15)) -and ($n.Minute -lt 3));",
    "$cu=($cm -ge 0) -and ((($n.Minute % 10) -eq $cm) -or (((($n.Minute + 1) % 10) -eq $cm) -and ($s -ge 50)));",
    "if (((($n - $last).TotalSeconds) -ge $im) -and ($d -gt $w) -and (-not $fix) -and (-not $cu) -and (-not (Young)) -and ((Busy) -eq 0)) { $go=$true; $idle=[int](($n - $last).TotalSeconds); break };",
    "Start-Sleep -Milliseconds 500 };",
    "if (-not $go) { Write-Host \"DRILL_ABORTED_BUSY $(Get-Date -Format HH:mm:ss)\" }",
    "elseif ($dry) { Write-Host \"DRILL_DRYRUN_WOULD_STOP $(Get-Date -Format HH:mm:ss) idle=$($idle)s chrome=$(@(Get-Process chrome -ErrorAction SilentlyContinue).Count) host=$(Busy)\" }",
    // 끄는 순서: 크롬(서비스 워커가 새 호스트를 못 열게) → 남은 호스트 → 예약 작업 인스턴스.
    "else { Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue;",
    `Get-CimInstance Win32_Process -Filter $f -ErrorAction SilentlyContinue | ${HOST_WHERE} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };`,
    `Stop-ScheduledTask ${TASK_ARGS} -ErrorAction SilentlyContinue;`,
    "Write-Host \"DRILL_STOPPED $(Get-Date -Format HH:mm:ss) idle=$($idle)s\"; Start-Sleep -Seconds 3;",
    "Write-Host \"DRILL_LEFT $((Busy) + @(Get-Process chrome -ErrorAction SilentlyContinue).Count)\"; Start-Sleep -Seconds $sec }",
    // 복구: 되살리는 명령을 먼저, 표시는 마지막(Ctrl+C 뒤 출력이 버려져도 복구는 끝나 있게).
    `} finally { if ($dry) { Write-Host "DRILL_DRYRUN_WOULD_RESTORE $(Get-Date -Format HH:mm:ss) task=$((Get-ScheduledTask ${TASK_ARGS}).State) restore=Enable-ScheduledTask,Start-ScheduledTask" }`,
    `else { $null=Enable-ScheduledTask ${TASK_ARGS}; Start-ScheduledTask ${TASK_ARGS} -ErrorAction SilentlyContinue; Write-Host "DRILL_RESTORED $(Get-Date -Format HH:mm:ss) task=$((Get-ScheduledTask ${TASK_ARGS}).State)" } } }`,
  ].join(" ");
}

function integerIn(value, low, high, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < low || number > high) throw new Error(`${name} 는 ${low}~${high} 정수(받은 값: ${value})`);
  return number;
}

export function drillOptions(input = {}) {
  const merged = { ...DRILL_DEFAULTS, dry: false, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  return {
    seconds: integerIn(merged.seconds, 60, 3600, "정지초"),
    center: integerIn(merged.center, 0, 59, "중심초"),
    halfWidth: integerIn(merged.halfWidth, 0, 29, "반폭"),
    catchUpDigit: integerIn(merged.catchUpDigit, -1, 9, "catch-up 분 끝자리"),
    dry: merged.dry === true,
  };
}

export function drillLine(input = {}) {
  const o = drillOptions(input);
  const values = { DRY: o.dry ? 1 : 0, SEC: o.seconds, C: o.center, W: o.halfWidth, CM: o.catchUpDigit };
  return drillTemplate().replace(/@(DRY|SEC|C|W|CM)@/gu, (_, key) => String(values[key]));
}

export function restoreLine() {
  return `${TASK_VARS} $null=Enable-ScheduledTask ${TASK_ARGS}; Start-ScheduledTask ${TASK_ARGS} -ErrorAction SilentlyContinue; Start-Sleep -Seconds 20; Write-Host "RESTORED $(Get-Date -Format HH:mm:ss) task=$((Get-ScheduledTask ${TASK_ARGS}).State) chrome=$(@(Get-Process chrome -ErrorAction SilentlyContinue).Count)"`;
}

// 문자열 안(작은따옴표·큰따옴표와 그 안의 $(...))을 지운 코드. 큰따옴표 안 백틱은 다음 글자를 escape 한다.
function codeWithoutStrings(line) {
  let out = "";
  for (let index = 0; index < line.length;) {
    const ch = line[index];
    if (ch === "'") {
      let end = index + 1;
      for (;;) {
        end = line.indexOf("'", end);
        if (end < 0) throw new Error("닫히지 않은 작은따옴표");
        if (line[end + 1] === "'") { end += 2; continue; }
        break;
      }
      out += " S "; index = end + 1; continue;
    }
    if (ch === "\"") {
      let end = index + 1; let depth = 0;
      for (; end < line.length; end += 1) {
        if (line[end] === "`") { end += 1; continue; }
        if (line.startsWith("$(", end)) { depth += 1; end += 1; continue; }
        if (depth > 0 && line[end] === "(") { depth += 1; continue; }
        if (depth > 0 && line[end] === ")") { depth -= 1; continue; }
        if (depth === 0 && line[end] === "\"") break;
      }
      if (end >= line.length) throw new Error("닫히지 않은 큰따옴표");
      out += " S "; index = end + 1; continue;
    }
    out += ch; index += 1;
  }
  return out;
}

// 윈도우에는 PowerShell 5.1 만 있다(여기에는 PowerShell 이 없다) → 구조만 오프라인으로 본다.
// PowerShell 의 -and 와 -or 는 우선순위가 같아 왼쪽부터 묶이므로 한 괄호 안에 섞이면 뜻이 바뀐다 → 섞이면 문제.
export function checkPowerShell51Line(line) {
  const problems = [];
  if (typeof line !== "string" || !line.trim()) return ["빈 줄"];
  if (/[\r\n]/u.test(line)) problems.push("한 줄이 아님");
  if (/@(?:DRY|SEC|C|W|CM)@/u.test(line)) problems.push("채우지 않은 자리표시자");
  let code;
  try { code = codeWithoutStrings(line); } catch (error) { return [...problems, error.message]; }
  const stack = []; const operators = new Map(); let depth = 0;
  for (const match of code.matchAll(/[(){}[\];]|(?<![=!<>+\-*/%])=(?!=)|-and\b|-or\b/gu)) {
    const token = match[0];
    if (token === ";" || token === "=") { operators.delete(depth); continue; }
    if ("({[".includes(token)) { stack.push(token); depth += 1; operators.delete(depth); continue; }
    if (")}]".includes(token)) {
      const open = stack.pop();
      if (open !== { ")": "(", "}": "{", "]": "[" }[token]) { problems.push(`괄호 짝이 틀림(${match.index}번째 글자 ${token})`); return problems; }
      operators.delete(depth); depth -= 1; continue;
    }
    const previous = operators.get(depth);
    if (previous && previous !== token) problems.push(`-and/-or 가 괄호 없이 섞임: …${code.slice(Math.max(0, match.index - 40), match.index + 12)}…`);
    operators.set(depth, token);
  }
  if (stack.length) problems.push(`닫히지 않은 괄호 ${stack.join("")}`);
  for (const token of ["??", "?.", "&&", "||"]) if (code.includes(token)) problems.push(`PowerShell 7 전용 연산자 ${token}`);
  if (/\s\?\s[^:]*\s:\s/u.test(code)) problems.push("PowerShell 7 전용 삼항 연산자");
  return problems;
}

function secondsWindowText(center, halfWidth) {
  return `${(center - halfWidth + 60) % 60}~${(center + halfWidth) % 60}`;
}

// CLI 가 찍는 줄들. DRY 여도 복구 한 줄(실제 훈련의 복구 경로)을 함께 찍는다.
export function drillOutput(input = {}) {
  const o = drillOptions(input);
  const line = drillLine(o);
  const catchUp = o.catchUpDigit < 0 ? "catch-up 분 제외 끔" : `매 x${o.catchUpDigit}분(과 앞 분 50초~) 제외`;
  const head = `# 초 ${secondsWindowText(o.center, o.halfWidth)} 제외, ${catchUp}, 08:58~09:02·14:58~15:02 제외, 호스트 ${IDLE_SECONDS}초 연속 없음, 크롬 시작 2분 뒤, 최대 ${WAIT_MINUTES}분 대기`;
  if (o.dry) {
    return [
      "# [DRY=1 시험] 관리자 PowerShell 에서 실행. 예약 작업·크롬·호스트를 건드리지 않는다(작업 상태 읽기만).",
      head,
      line,
      `# 기대: DRILL_WAITING → DRILL_DRYRUN_WOULD_STOP <시각> idle=<${IDLE_SECONDS} 이상>s chrome=<n> host=0 → DRILL_DRYRUN_WOULD_RESTORE <시각> task=Ready restore=Enable-ScheduledTask,Start-ScheduledTask`,
      "# 실제 훈련의 복구 경로: finally 가 Enable-ScheduledTask → Start-ScheduledTask 를 실행한다. 창을 닫아 finally 가 못 돌면 아래 복구 한 줄:",
      restoreLine(),
    ];
  }
  return [
    `# 윈도우 주작업기 훈련 — 관리자 PowerShell(5.1). 한가할 때만 크롬·호스트를 끄고 ${o.seconds}초 뒤 되살린다.`,
    head,
    line,
    `# 기대: DRILL_WAITING → DRILL_STOPPED <시각> idle=<${IDLE_SECONDS} 이상>s → DRILL_LEFT 0 → (${o.seconds}초 뒤) DRILL_RESTORED <시각> task=Ready|Running. ${WAIT_MINUTES}분 안에 한가한 순간이 없으면 DRILL_ABORTED_BUSY(끄지 않고 복구만).`,
    "# Ctrl+C 뒤에도 finally 가 되살리도록 짰다(PS 5.1 실기 미확인). 창을 클릭하면(빠른 편집) 스크립트가 멈추니 Esc. 창을 닫았거나 Ctrl+C 뒤 DRILL_RESTORED 가 안 보이면 아래 복구 한 줄(관리자 창, 여러 번 실행해도 안전):",
    restoreLine(),
  ];
}

// 제외 위상: rank-remote 런 시작 초의 최빈값, rank-catch-up 런 시작 분 끝자리의 최빈값(KST 는 UTC+9 정시라 초·분 끝자리가 같다).
// catch-up 이 10분 주기가 아니거나 표본이 3 미만이거나 최빈 비율이 60% 미만이면 불안정 → 한 줄을 만들지 않는다.
export function phaseFromRuns(runs, cadenceMinutes) {
  const mode = (values) => {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] || [null, 0];
  };
  const startedOf = (trigger) => runs.filter((run) => run.run_trigger === trigger).map((run) => new Date(run.started_at)).filter((at) => !Number.isNaN(at.getTime()));
  const remote = startedOf("rank-remote").map((at) => at.getUTCSeconds());
  const catchUp = startedOf("rank-catch-up");
  const [remoteSecond, remoteCount] = mode(remote);
  const [digit, digitCount] = mode(catchUp.map((at) => at.getUTCMinutes() % 10));
  const catchUpSeconds = catchUp.map((at) => at.getUTCSeconds());
  const problems = [];
  if (Number(cadenceMinutes) !== 10) problems.push(`cadence_minutes=${cadenceMinutes}(10분 주기가 아니면 분 끝자리 제외가 맞지 않는다)`);
  if (catchUp.length < 3) problems.push(`catch-up 표본 ${catchUp.length}개(<3)`);
  else if (digitCount < Math.ceil(catchUp.length * 0.6)) problems.push(`catch-up 분 끝자리 최빈 ${digitCount}/${catchUp.length}(<60%)`);
  return {
    center: remote.length >= 3 ? remoteSecond : DRILL_DEFAULTS.center,
    catchUpDigit: digit,
    remote: `${remoteSecond}(${remoteCount}/${remote.length})`,
    catchUp: `${digit}(${digitCount}/${catchUp.length})`,
    catchUpSecondRange: catchUpSeconds.length ? `${Math.min(...catchUpSeconds)}-${Math.max(...catchUpSeconds)}` : "-",
    problems,
    stable: problems.length === 0,
  };
}

const isMain = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const emit = (lines) => {
    const bad = lines.filter((line) => !line.startsWith("#")).flatMap((line) => checkPowerShell51Line(line));
    if (bad.length) { console.error(`PS 5.1 구조 검사 실패: ${bad.join(" / ")}`); process.exit(1); }
    console.log(lines.join("\n"));
  };
  if (command === "restore") {
    emit(["# 복구 전용 한 줄(관리자 PowerShell): 예약 작업 켜기 → 시작 → 20초 뒤 상태", restoreLine()]);
  } else if (command === "check") {
    if (!rest[0]) { console.error("usage: node windows-drill.mjs check <한 줄 파일>"); process.exit(2); }
    const lines = fs.readFileSync(rest[0], "utf8").replace(/\r?\n$/u, "");
    const problems = checkPowerShell51Line(lines);
    console.log(problems.length ? `PS51_CHECK_FAILED ${problems.join(" / ")}` : `PS51_CHECK_OK chars=${lines.length}`);
    process.exit(problems.length ? 1 : 0);
  } else if (command === "phase") {
    const hours = Number(rest[0] || 2); const worker = rest[1] || "windows-desktop-primary";
    const env = Object.fromEntries(fs.readFileSync(path.join(os.homedir(), ".config/momentinsight/backup.env"), "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
    const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
    const get = async (query) => { const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${query}`, { headers }); if (!response.ok) throw new Error(`GET ${query.split("?")[0]} ${response.status}`); return response.json(); };
    const since = new Date(Date.now() - hours * 3600e3).toISOString();
    const [coordination] = await get("naver_shopping_worker_coordination?select=cadence_minutes&lane_key=eq.global");
    const runs = await get(`naver_shopping_worker_runs?select=run_trigger,started_at&worker_id=eq.${encodeURIComponent(worker)}&started_at=gte.${since}&order=started_at.asc`);
    const phase = phaseFromRuns(runs, coordination?.cadence_minutes);
    console.log(`runs=${runs.length} cadence=${coordination?.cadence_minutes} rank-remote 초 최빈=${phase.remote} catch-up 분 끝자리 최빈=${phase.catchUp} catch-up 초 범위=${phase.catchUpSecondRange}`);
    if (!phase.stable) { console.log(`PHASE_UNSTABLE ${phase.problems.join(" / ")} → 훈련을 미룬다(10분 주기에서 표본이 쌓인 뒤 다시 잰다)`); process.exit(3); }
    console.log(`node windows-drill.mjs ${DRILL_DEFAULTS.seconds} ${phase.center} ${DRILL_DEFAULTS.halfWidth} ${phase.catchUpDigit}`);
  } else {
    const args = [command, ...rest].filter((value) => value !== undefined);
    if (args.some((value) => !/^-?\d+$/u.test(value)) || !["0", "1", undefined].includes(process.env.DRY)) {
      console.error("usage: [DRY=1] node windows-drill.mjs [정지초=900] [중심초=25] [반폭=7] [catch-up 분 끝자리=4|-1] | restore | check <파일> | phase [시간]");
      process.exit(2);
    }
    let lines;
    try {
      lines = drillOutput({ seconds: args[0], center: args[1], halfWidth: args[2], catchUpDigit: args[3], dry: process.env.DRY === "1" });
    } catch (error) { console.error(error.message); process.exit(2); }
    emit(lines);
  }
}

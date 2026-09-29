import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DRILL_DEFAULTS,
  HOST_LAUNCHER,
  HOST_SCRIPT,
  IDLE_SECONDS,
  RUN_MARGIN_SECONDS,
  TASK_NAME,
  TASK_PATH,
  WAIT_MINUTES,
  checkPowerShell51Line,
  drillLine,
  drillOutput,
  phaseFromRuns,
  restoreLine,
} from "../docs/skills/mi-collection-incident/scripts/windows-drill.mjs";

// 2026-09-29 3차 훈련: 윈도우 rank-catch-up 수집 도중 크롬·호스트를 죽이자 임대가 35분 남아 맥·윈도우 모두 멈췄다(F1).
// 훈련 한 줄(docs/skills/mi-collection-incident/scripts/windows-drill.mjs)의 안전 조건 네 가지를 고정한다:
// ① 한가함 대기 ② 초 창(과 시각 제외) ③ 정지 순서 ④ 복구. 여기에는 PowerShell 이 없으므로 생성된 줄의 글자를 읽어
// 구조를 검사하고, 시각 판정식은 같은 글자를 JavaScript 로 옮겨 하루 전체(86400초)를 평가한다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const serviceWorker = read("tools/naver-shopping-chrome-extension/service-worker.js");
const updater = read("scripts/windows/update-naver-shopping-chrome-extension.ps1");
const workerHandler = read("src/server/handlers/naver-shopping-local-worker.mjs");
const runbook = read("docs/RUNBOOK.md");
const runbookDrill = runbook.slice(runbook.indexOf("- **훈련 도구(윈도우 주작업기 정지)**"), runbook.indexOf("- **정상화 기준(배포 뒤)**"));
const tool = path.join(root, "docs/skills/mi-collection-incident/scripts/windows-drill.mjs");
const constant = (source, name) => Number(source.match(new RegExp(`const ${name} = ([\\d_]+);`, "u"))[1].replaceAll("_", ""));

const WAIT_BODY_START = "$n=Get-Date;";
const WAIT_BODY_END = "Start-Sleep -Milliseconds 500";

// 생성된 줄의 대기 루프 판정부(초·정각·catch-up·한가함·크롬 나이·호스트 수)를 JavaScript 로 옮긴다.
// checkPowerShell51Line 이 한 괄호 안의 -and/-or 혼용을 막으므로 && · || 의 우선순위 차이는 결과를 바꾸지 않는다.
function stopPredicate(line) {
  const params = Object.fromEntries([...line.matchAll(/\$(dry|sec|c|w|cm|im)=(-?\d+);/gu)].map((m) => [m[1], Number(m[2])]));
  const start = line.indexOf(WAIT_BODY_START);
  const end = line.indexOf(WAIT_BODY_END);
  assert.ok(start > 0 && end > start, "wait loop body");
  const body = line.slice(start + WAIT_BODY_START.length, end)
    .replace("{ $go=$true; $idle=[int](($n - $last).TotalSeconds); break }", "{ v.go = true }")
    .replaceAll("(($n - $last).TotalSeconds)", "(v.idleSeconds)")
    .replaceAll("(Young)", "(v.young)")
    .replaceAll("(Busy)", "(v.busy)")
    .replaceAll("[Math]::Abs(", "Math.abs(")
    .replaceAll("-not ", "!")
    .replaceAll(" -eq ", " === ").replaceAll(" -ne ", " !== ")
    .replaceAll(" -ge ", " >= ").replaceAll(" -gt ", " > ")
    .replaceAll(" -le ", " <= ").replaceAll(" -lt ", " < ")
    .replaceAll(" -and ", " && ").replaceAll(" -or ", " || ")
    .replaceAll(/\$([a-z]+)/gu, "v.$1");
  assert.doesNotMatch(body, /\s-[a-z]+\s|\$|Get-|Start-/u, `untranslated PowerShell left: ${body}`);
  // eslint-disable-next-line no-new-func
  const run = new Function("v", body);
  return ({ hour, minute, second, idleSeconds = 60, young = false, busy = 0 }) => {
    const v = { ...params, n: { Hour: hour, Minute: minute, Second: second }, idleSeconds, young, busy, go: false };
    run(v);
    return v.go;
  };
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const blockedSeconds = (allowed, hour, minute) => range(0, 59).filter((second) => !allowed({ hour, minute, second }));

// 어떤 프로세스를 호스트로 세는지(Busy)·끄는지·크롬 본체 나이(Young)도 생성된 글자를 JavaScript 로 옮겨 표본 프로세스에 평가한다.
// WQL 필터(Name='a' OR Name='b', 대소문자 무시)와 Where-Object 판정식(-eq/-ne/-like/-notlike, -gt (Get-Date).AddSeconds(n), -and/-or)만 다룬다.
const wildcard = (pattern) => new RegExp(`^${[...pattern].map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/gu, "\\$&"))).join("")}$`, "iu");

function wqlFilter(filter) {
  const parts = filter.split(/\s+(OR|AND)\s+/u);
  const joins = new Set(parts.filter((_, index) => index % 2 === 1));
  assert.ok(joins.size <= 1, `WQL OR/AND mixed: ${filter}`);
  const names = parts.filter((_, index) => index % 2 === 0).map((term) => {
    const match = term.match(/^Name='([^']+)'$/u);
    assert.ok(match, `WQL term: ${term}`);
    return match[1].toLowerCase();
  });
  const any = !joins.has("AND");
  return (process) => (any ? names.some((name) => name === process.Name.toLowerCase()) : names.every((name) => name === process.Name.toLowerCase()));
}

function wherePredicate(body) {
  const js = body.replace(/\s+/gu, " ").trim()
    .replace(/\$_\.(\w+) -(not)?like (['"])([^'"]*)\3/gu, (_, property, not, _quote, pattern) => `${not ? "!" : ""}h.like(p.${property}, ${JSON.stringify(pattern)})`)
    .replace(/\$_\.(\w+) -(eq|ne) (['"])([^'"]*)\3/gu, (_, property, operator, _quote, value) => `${operator === "ne" ? "!" : ""}h.same(p.${property}, ${JSON.stringify(value)})`)
    .replace(/\$_\.(\w+) -gt \(Get-Date\)\.AddSeconds\((-?\d+)\)/gu, (_, property, seconds) => `(p.${property} > h.now + (${seconds}) * 1000)`)
    .replaceAll(" -and ", " && ").replaceAll(" -or ", " || ");
  assert.doesNotMatch(js, /\$|\s-[a-z]+\s|Get-/iu, `untranslated PowerShell left: ${js}`);
  // eslint-disable-next-line no-new-func
  const run = new Function("p", "h", `return (${js});`);
  // PowerShell 문자열 비교는 대소문자를 무시하고, $null 은 -eq/-like 가 거짓·-ne/-notlike 가 참이다.
  const helpers = (now) => ({
    now,
    like: (value, pattern) => typeof value === "string" && wildcard(pattern).test(value),
    same: (value, expected) => typeof value === "string" && value.toLowerCase() === expected.toLowerCase(),
  });
  return (process, now = 0) => Boolean(run(process, helpers(now)));
}

// Busy(프로세스 목록) → 호스트 수. null 은 CIM 조회 실패: -ErrorAction Stop 이어야 예외가 catch 로 가고, 그 밖은 빈 결과(0)다.
function busyModel(line) {
  const match = line.match(/function Busy \{ try \{ @\(Get-CimInstance Win32_Process -Filter \$f -ErrorAction (\w+) \| Where-Object \{ (.*?) \}\)\.Count \} catch \{ (\d+) \} \};/u);
  assert.ok(match, "Busy");
  const [, errorAction, where, caught] = match;
  const filter = wqlFilter(line.match(/\$f="([^"]+)";/u)[1]);
  const counts = wherePredicate(where);
  return {
    where,
    busy: (processes) => (processes === null ? (errorAction === "Stop" ? Number(caught) : 0) : processes.filter((p) => filter(p) && counts(p)).length),
  };
}

function youngModel(line) {
  const match = line.match(/function Young \{ @\(Get-CimInstance Win32_Process -Filter "([^"]+)" -ErrorAction \w+ \| Where-Object \{ (.*?) \}\)\.Count -gt 0 \};/u);
  assert.ok(match, "Young");
  const filter = wqlFilter(match[1]);
  const young = wherePredicate(match[2]);
  return (processes, now) => processes.some((p) => filter(p) && young(p, now));
}

const EXTENSION_ORIGIN = "chrome-extension://pflggephankeefaeoaafkmggampnaefm/";
const BRIDGE = "C:\\Users\\owner\\AppData\\Local\\MomentInsight\\NaverShoppingBridge";
const CHROME_EXE = "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"";
const PROCESSES = {
  launcher: { Name: HOST_LAUNCHER, CommandLine: `"${BRIDGE}\\${HOST_LAUNCHER}" ${EXTENSION_ORIGIN} --parent-window=0` },
  hostNode: { Name: "node.exe", CommandLine: `"C:\\Program Files\\nodejs\\node.exe" "${BRIDGE}\\${HOST_SCRIPT}" ${EXTENSION_ORIGIN}` },
  otherNode: { Name: "node.exe", CommandLine: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\dev\\tools\\server.mjs" },
  unreadableNode: { Name: "node.exe", CommandLine: null },
  chromeMain: { Name: "chrome.exe", CommandLine: `${CHROME_EXE} --profile-directory="Profile 1"` },
  chromeRenderer: { Name: "chrome.exe", CommandLine: `${CHROME_EXE} --type=renderer --renderer-client-id=7` },
  explorer: { Name: "explorer.exe", CommandLine: "C:\\Windows\\explorer.exe" },
};

test("every generated line is one Windows PowerShell 5.1 line and the checker catches what 5.1 cannot run", () => {
  for (const line of [drillLine(), drillLine({ dry: true }), drillLine({ center: 57, catchUpDigit: -1 }), restoreLine()]) {
    assert.deepEqual(checkPowerShell51Line(line), [], line.slice(0, 80));
  }
  const good = drillLine();
  // 오프라인 검사기가 잡아야 하는 것: -and/-or 혼용, PS7 연산자, 여러 줄, 괄호 짝, 남은 자리표시자.
  assert.match(checkPowerShell51Line(good.replace("(-not $fix) -and (-not $cu)", "(-not $fix) -or (-not $cu)")).join(), /섞임/u);
  assert.match(checkPowerShell51Line(good.replace("$idle=0;", "$idle=$x ?? 0;")).join(), /\?\?/u);
  assert.match(checkPowerShell51Line(good.replace("$idle=0;", "$idle=0;\n")).join(), /한 줄/u);
  assert.match(checkPowerShell51Line(good.replace("break };", "break ;")).join(), /괄호/u);
  assert.match(checkPowerShell51Line(good.replace("$sec=900;", "$sec=@SEC@;")).join(), /자리표시자/u);
  assert.throws(() => drillLine({ seconds: 30 }), /정지초/u);
  assert.throws(() => drillLine({ catchUpDigit: 10 }), /catch-up/u);
});

test("① idle wait: the host must be absent longer than the extension's queued follow-up handoff, re-measured last", () => {
  const handoffMs = constant(serviceWorker, "PENDING_TRIGGER_HANDOFF_MS");
  const line = drillLine();
  assert.equal(Number(line.match(/\$im=(\d+);/u)[1]), IDLE_SECONDS);
  assert.ok(IDLE_SECONDS * 1000 >= handoffMs + 4000, `idle ${IDLE_SECONDS}s must exceed the ${handoffMs}ms handoff plus polling slack`);
  // 한가함 기준 시각은 대기 시작 시각에서 출발하고, 호스트가 보이면 다시 잡는다.
  assert.ok(line.indexOf("$last=Get-Date; $until=") < line.indexOf("while ((Get-Date) -lt $until)"));
  assert.ok(line.includes("while ((Get-Date) -lt $until) { if ((Busy) -gt 0) { $last=Get-Date };"));
  // 호스트 조회가 실패하면 바쁨(99)이라 멈추지 않는다. 멈추기 직전 마지막 항은 새로 잰 호스트 0.
  assert.ok(line.includes("function Busy { try {") && line.includes("} catch { 99 } };"));
  assert.match(line, /-and \(-not \(Young\)\) -and \(\(Busy\) -eq 0\)\) \{ \$go=\$true;/u);
  const allowed = stopPredicate(line);
  const quiet = { hour: 10, minute: 0, second: 45 };
  assert.equal(allowed({ ...quiet, idleSeconds: IDLE_SECONDS }), true);
  assert.equal(allowed({ ...quiet, idleSeconds: IDLE_SECONDS - 0.5 }), false);
  assert.equal(allowed({ ...quiet, busy: 1 }), false);
  assert.equal(allowed({ ...quiet, busy: 99 }), false);
  assert.equal(allowed({ ...quiet, young: true }), false);
  // 45분 안에 한가한 순간이 없으면 끄지 않는다.
  assert.ok(line.includes("if (-not $go) { Write-Host \"DRILL_ABORTED_BUSY"));
  // 대기 상한은 맥 catch-up 두 주기 이상(한가한 틈을 적어도 두 번 만난다)이고, RUNBOOK D 가 약속한 '최대 45분'과 같다.
  const cadence = Math.max(constant(serviceWorker, "BASELINE_CADENCE_MINUTES"), constant(serviceWorker, "CANDIDATE_CADENCE_MINUTES"));
  assert.ok(WAIT_MINUTES >= 2 * cadence, `wait ${WAIT_MINUTES}min < two ${cadence}min catch-up cycles`);
  assert.ok(line.includes(`max=${WAIT_MINUTES}m`) && line.includes(`$until=(Get-Date).AddMinutes(${WAIT_MINUTES});`));
  assert.ok(runbookDrill.includes(`최대 ${WAIT_MINUTES}분`), `RUNBOOK D must state the ${WAIT_MINUTES}-minute wait`);
});

test("① host count: Busy counts exactly the updater's host processes (without chrome.exe), and a failed query counts as busy", () => {
  const line = drillLine();
  const { where, busy } = busyModel(line);
  const { launcher, hostNode, otherNode, unreadableNode, chromeMain, chromeRenderer, explorer } = PROCESSES;
  assert.equal(busy([launcher]), 1, "launcher exe");
  assert.equal(busy([hostNode]), 1, "node running the native host script");
  assert.equal(busy([otherNode, unreadableNode, chromeMain, chromeRenderer, explorer]), 0, "unrelated node, chrome and others");
  assert.equal(busy(Object.values(PROCESSES)), 2);
  // CIM 조회 실패 = 바쁨(-ErrorAction Stop → catch { 99 }) → 멈추지 않는다.
  assert.ok(busy(null) > 0, "failed CIM query must count as busy");
  assert.equal(stopPredicate(line)({ hour: 10, minute: 0, second: 45, busy: busy(null) }), false);
  // 끄는 대상은 세는 대상과 같은 필터·판정식이다.
  assert.ok(line.includes(`Get-CimInstance Win32_Process -Filter $f -ErrorAction SilentlyContinue | Where-Object { ${where} } | ForEach-Object { Stop-Process -Id $_.ProcessId`));
  // 업데이터(Get-UpdateTargetProcesses)가 끝나기를 기다리는 프로세스에서 chrome.exe 만 뺀 것과 같다.
  const updaterBody = updater.match(/function Get-UpdateTargetProcesses \{[\s\S]*?Get-CimInstance Win32_Process -ErrorAction Stop \| Where-Object \{([\s\S]*?)\}\)/u);
  assert.ok(updaterBody, "updater Get-UpdateTargetProcesses");
  const updaterTarget = wherePredicate(updaterBody[1]);
  for (const [name, process] of Object.entries(PROCESSES)) {
    assert.equal(busy([process]) === 1, updaterTarget(process) && process.Name !== "chrome.exe", name);
  }
});

test("① Chrome age: only the main process (no --type=) started within 120 seconds makes the drill wait", () => {
  const young = youngModel(drillLine());
  const now = Date.parse("2026-09-29T07:00:00Z");
  const main = (secondsAgo) => ({ ...PROCESSES.chromeMain, CreationDate: now - secondsAgo * 1000 });
  const renderer = (secondsAgo) => ({ ...PROCESSES.chromeRenderer, CreationDate: now - secondsAgo * 1000 });
  assert.equal(young([main(60)], now), true);
  assert.equal(young([main(119)], now), true);
  assert.equal(young([main(121)], now), false);
  // 렌더러·도우미(--type=)는 늘 새로 뜬다 — 본체가 오래됐으면 기다리지 않는다.
  assert.equal(young([main(600), renderer(5)], now), false);
  // 크롬이 아닌 새 프로세스는 보지 않는다.
  assert.equal(young([{ ...PROCESSES.hostNode, CreationDate: now - 5000 }], now), false);
});

test("② second window and clock exclusions: seconds [18,32], 08:58-09:02 and 14:58-15:02, the catch-up minute", () => {
  const allowed = stopPredicate(drillLine());
  for (const minute of [0, 1, 7, 9, 10, 59]) assert.deepEqual(blockedSeconds(allowed, 10, minute), range(18, 32), `10:${minute}`);
  // 60 경계를 넘는 원형 거리: 중심 57 ± 7 = 50..59, 0..4
  const wrapped = stopPredicate(drillLine({ center: 57, catchUpDigit: -1 }));
  assert.deepEqual(blockedSeconds(wrapped, 10, 0), [...range(0, 4), ...range(50, 59)]);
  // 정각 알람(rank-0900/1500, hh:00:01) 앞뒤: 분 전체 판정은 초 45(창 밖)에서, catch-up 제외는 끈 줄로 따로 본다.
  const noCatchUp = stopPredicate(drillLine({ catchUpDigit: -1 }));
  const fixed = new Set(["8:58", "8:59", "9:0", "9:1", "9:2", "14:58", "14:59", "15:0", "15:1", "15:2"]);
  for (const hour of range(0, 23)) {
    for (const minute of range(0, 59)) {
      assert.equal(noCatchUp({ hour, minute, second: 45 }), !fixed.has(`${hour}:${minute}`), `${hour}:${minute}:45`);
    }
  }
  // catch-up 분 끝자리 4: x4 분 전체와 x3:50~59 를 막고, -1 이면 끄다.
  for (const minute of range(0, 59)) {
    for (const second of [0, 10, 33, 45, 49, 50, 59]) {
      const expected = !(minute % 10 === 4 || (minute % 10 === 3 && second >= 50));
      assert.equal(allowed({ hour: 10, minute, second }), expected, `10:${minute}:${second}`);
      assert.equal(noCatchUp({ hour: 10, minute, second }), true, `catch-up off 10:${minute}:${second}`);
    }
  }
});

test("③ stop order: task disabled before waiting, chrome then hosts then the task only after the idle break, never in DRY", () => {
  const line = drillLine();
  const at = (needle, from = 0) => { const index = line.indexOf(needle, from); assert.ok(index >= 0, needle); return index; };
  const disable = at("Disable-ScheduledTask -TaskPath $tp -TaskName $tn -ErrorAction Stop | Out-Null; $dis=$true");
  const tryBlock = at("if ($dis) { try {");
  const wait = at("while ((Get-Date) -lt $until)");
  const go = at("$go=$true;");
  const abort = at("if (-not $go) {");
  const dry = at("elseif ($dry) { Write-Host \"DRILL_DRYRUN_WOULD_STOP");
  const chrome = at("Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force");
  const hosts = at("ForEach-Object { Stop-Process -Id $_.ProcessId -Force");
  const task = at("Stop-ScheduledTask -TaskPath $tp -TaskName $tn");
  const stopped = at("DRILL_STOPPED");
  const sleep = at("Start-Sleep -Seconds $sec");
  const final = at("} finally {");
  assert.ok(disable < tryBlock && tryBlock < wait && wait < go && go < abort && abort < dry && dry < chrome);
  assert.ok(chrome < hosts && hosts < task && task < stopped && stopped < sleep && sleep < final);
  // 끄는 명령은 한 번씩, 모두 '멈춤' 가지(한가함 확인 뒤·DRY 아님) 안에만 있다.
  for (const needle of ["Stop-Process -Force", "Stop-Process -Id", "Stop-ScheduledTask"]) {
    assert.equal(line.split(needle).length, 2, needle);
    assert.ok(line.indexOf(needle) > dry, needle);
  }
  // DRY 는 예약 작업을 끄지 않는다(Disable 은 DRY 가 아닌 가지에만).
  assert.ok(at("elseif ($dry) { $dis=$true } else { try { Disable-ScheduledTask") < disable);
  // 업데이터가 멈추는 대상과 같은 작업·프로세스.
  assert.ok(updater.includes(`$taskPath = "${TASK_PATH}"`));
  assert.ok(updater.includes(`$taskName = "${TASK_NAME}"`));
  for (const name of [HOST_LAUNCHER, HOST_SCRIPT]) {
    assert.ok(updater.includes(name), name);
    assert.ok(line.includes(name), name);
  }
  assert.ok(line.includes(`$tp="${TASK_PATH}"; $tn="${TASK_NAME}";`));
});

test("④ restore: finally re-enables then starts the task, DRY prints that restore path, and the restore-only line does the same", () => {
  const line = drillLine();
  const final = line.indexOf("} finally {");
  const finallyBlock = line.slice(final);
  // 정지초 대기(Start-Sleep -Seconds $sec)와 대기 루프가 모두 이 try 안이라 Ctrl+C·예외도 finally 로 복구한다.
  assert.ok(line.indexOf("if ($dis) { try {") < line.indexOf("Start-Sleep -Seconds $sec"));
  assert.equal(line.split("} finally {").length, 2);
  const enable = finallyBlock.indexOf("$null=Enable-ScheduledTask -TaskPath $tp -TaskName $tn;");
  const start = finallyBlock.indexOf("Start-ScheduledTask -TaskPath $tp -TaskName $tn");
  const restored = finallyBlock.indexOf("DRILL_RESTORED");
  assert.ok(enable > 0 && enable < start && start < restored, "Enable → Start → 표시");
  // DRY: 끄지도 되살리지도 않고 복구 경로(작업 상태와 실행할 명령)를 찍는다.
  const dryLine = drillLine({ dry: true });
  assert.match(dryLine, /^\$dry=1;/u);
  assert.match(dryLine, /finally \{ if \(\$dry\) \{ Write-Host "DRILL_DRYRUN_WOULD_RESTORE [^"]*task=\$\(\(Get-ScheduledTask -TaskPath \$tp -TaskName \$tn\)\.State\) restore=Enable-ScheduledTask,Start-ScheduledTask" \} else \{ \$null=Enable-ScheduledTask/u);
  const restore = restoreLine();
  assert.ok(restore.startsWith(`$tp="${TASK_PATH}"; $tn="${TASK_NAME}"; $null=Enable-ScheduledTask`));
  assert.ok(restore.indexOf("Enable-ScheduledTask") < restore.indexOf("Start-ScheduledTask"));
  assert.doesNotMatch(restore, /Stop-|Disable-/u);
  // 생성기 출력: DRY 여도 복구 한 줄을 함께 찍는다.
  for (const dry of [false, true]) {
    const output = drillOutput({ dry });
    assert.ok(output.includes(drillLine({ dry })));
    assert.equal(output.at(-1), restore);
  }
});

test("the default stop covers the standby handoff plus one Mac catch-up cycle plus one run", () => {
  const primaryStale = Number(workerHandler.match(/p_primary_stale_seconds: (\d+),/u)[1]);
  const cadence = Math.max(constant(serviceWorker, "BASELINE_CADENCE_MINUTES"), constant(serviceWorker, "CANDIDATE_CADENCE_MINUTES"));
  assert.ok(
    DRILL_DEFAULTS.seconds >= primaryStale + cadence * 60 + RUN_MARGIN_SECONDS,
    `${DRILL_DEFAULTS.seconds}s < ${primaryStale}s handoff + ${cadence}min catch-up + ${RUN_MARGIN_SECONDS}s run`,
  );
  assert.match(drillLine(), /\$sec=900;/u);
});

test("the CLI prints the drill line, the expectations and the restore line, in DRY mode too", () => {
  const { DRY: _ignored, ...baseEnv } = process.env;
  const cli = (args, env = {}) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", env: { ...baseEnv, ...env } });
  const dry = cli(["900", "25", "7", "4"], { DRY: "1" });
  assert.equal(dry.status, 0, dry.stderr);
  const lines = dry.stdout.trimEnd().split("\n");
  assert.deepEqual(lines, drillOutput({ dry: true }));
  assert.ok(lines.includes(drillLine({ dry: true })));
  assert.ok(lines.includes(restoreLine()));
  const real = cli([]);
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(real.stdout.trimEnd().split("\n"), drillOutput());
  assert.equal(cli(["restore"]).stdout.trimEnd().split("\n").at(-1), restoreLine());
  assert.equal(cli(["30"]).status, 2);
  assert.equal(cli(["abc"]).status, 2);
  assert.equal(cli([], { DRY: "2" }).status, 2);
});

test("phase measurement recommends arguments only for a stable 10-minute catch-up phase", () => {
  const at = (minute, second) => `2026-09-29T07:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
  const runs = [
    ...[4, 14, 24, 34].map((minute) => ({ run_trigger: "rank-catch-up", started_at: at(minute, 33) })),
    { run_trigger: "rank-catch-up", started_at: at(50, 34) },
    ...[1, 2, 3].map((minute) => ({ run_trigger: "rank-remote", started_at: at(minute, 26) })),
  ];
  const stable = phaseFromRuns(runs, 10);
  assert.equal(stable.stable, true);
  assert.equal(stable.center, 26);
  assert.equal(stable.catchUpDigit, 4);
  assert.equal(stable.catchUpSecondRange, "33-34");
  assert.equal(phaseFromRuns(runs, 6).stable, false);
  assert.equal(phaseFromRuns(runs.slice(3), 10).stable, false);
  const scattered = [0, 1, 2, 3, 4].map((minute) => ({ run_trigger: "rank-catch-up", started_at: at(minute * 11, 33) }));
  assert.equal(phaseFromRuns(scattered, 10).stable, false);
  // rank-remote 표본이 적으면 중심초는 기본값.
  assert.equal(phaseFromRuns(runs.slice(0, 5), 10).center, DRILL_DEFAULTS.center);
});

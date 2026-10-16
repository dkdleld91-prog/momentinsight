import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { calendarTicks, hasN30MainChrome, isWaitableGuardReason, readTail, runGuard } from "../lib/guards.mjs";
import { MAC_EDGE_CONFIG, WINDOWS_CONFIG, macChromeConfig, removeRoot, tempRoot } from "./helpers.mjs";

// 맥 현지 시각 11:00(달력 틱 08:50·14:50 과 멀다).
const NOW = new Date(2026, 9, 17, 11, 0, 0, 0).getTime();
const MAIN_CHROME = "/Users/tester/Desktop/Google Chrome.app/Contents/MacOS/Google Chrome";

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function chromeRun({ pids = "101\n", commands = { 101: MAIN_CHROME } } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/pgrep") {
      if (!pids) throw Object.assign(new Error("no match"), { status: 1 });
      return pids;
    }
    if (command === "/bin/ps") {
      const pid = args[args.length - 1];
      if (!(pid in commands)) throw new Error("no process");
      return `${commands[pid]}\n`;
    }
    throw new Error(`unexpected ${command}`);
  };
  return { run, calls };
}

function logs({ scheduler = [], watchdog = [] } = {}) {
  return (file) => {
    const lines = file.includes("scheduler") ? scheduler : watchdog;
    if (lines === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return lines.map(([at, text]) => `${iso(at)} ${text}`).join("\n") + "\n";
  };
}

const QUIET = logs({
  scheduler: [[NOW - 200000, "chrome_profile_forwarded profile=Profile 5 loaded=0"]],
  watchdog: [[NOW - 230000, "runtime_in_sync files=14"], [NOW - 230000, "healthy stalled_minutes=2"]],
});

test("Edge 면 늘 통과(윈도우·맥), 검사 명령을 부르지 않는다", () => {
  const { run, calls } = chromeRun();
  assert.deepEqual(runGuard(WINDOWS_CONFIG, { now: NOW, run, readTail: QUIET }), { ok: true, mode: "none" });
  assert.deepEqual(runGuard(MAC_EDGE_CONFIG, { now: NOW, run, readTail: QUIET }), { ok: true, mode: "none" });
  assert.equal(calls.length, 0);
});

test("맥 Chrome: N30 본체가 떠 있고 틱이 멀면 통과", () => {
  const { run, calls } = chromeRun();
  assert.deepEqual(runGuard(macChromeConfig(), { now: NOW, run, readTail: QUIET }), { ok: true, mode: "n30-chrome" });
  assert.deepEqual(calls[0], ["/usr/bin/pgrep", "-x", "Google Chrome"]);
  assert.deepEqual(calls[1], ["/bin/ps", "-o", "command=", "-p", "101"]);
});

test("N30 본체 크롬: pgrep 결과 없음 → 쉼", () => {
  const { run } = chromeRun({ pids: "" });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: QUIET }).reason, "guard_n30_chrome_missing");
});

test("N30 본체 크롬: --user-data-dir·--type= 이 붙은 것뿐이면 쉼", () => {
  const { run } = chromeRun({
    pids: "201\n202\n",
    commands: {
      201: `${MAIN_CHROME} --user-data-dir=/Users/tester/Library/Application Support/MomentInsight/CoupangRank/runs/mi-coupang-run-1-a`,
      202: `${MAIN_CHROME} Helper --type=renderer`,
    },
  });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: QUIET }).reason, "guard_n30_chrome_missing");
});

test("N30 본체 크롬: 명령줄 문자열만 맞는 다른 프로세스는 pgrep -x 에 안 잡히므로 쉼", () => {
  // pgrep -x 는 실행 파일 이름이 정확히 "Google Chrome" 인 것만 준다. 그 경로를 인자로 가진 다른 프로세스는 목록에 없다.
  const { run } = chromeRun({ pids: "", commands: { 301: `/usr/bin/tail -f "${MAIN_CHROME}"` } });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: QUIET }).reason, "guard_n30_chrome_missing");
  assert.equal(hasN30MainChrome(chromeRun({ pids: "301\n", commands: {} }).run), false);
});

test("로그가 없거나 오래되면(간격 + 300초 초과) guard_n30_tick_unknown", () => {
  const { run } = chromeRun();
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: logs({ scheduler: null, watchdog: [] }) }).reason, "guard_n30_tick_unknown");
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: logs({ scheduler: [], watchdog: [[NOW - 100000, "healthy"]] }) }).reason, "guard_n30_tick_unknown");
  const old = logs({ scheduler: [[NOW - 901000, "x"]], watchdog: [[NOW - 100000, "healthy"]] });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: old }).reason, "guard_n30_tick_unknown");
  const edge = logs({ scheduler: [[NOW - 899000, "x"]], watchdog: [[NOW - 230000, "healthy"]] });
  // 899초 전 틱 + 600 = 299초 전(지남), +1200 = 301초 뒤 → 겹치지 않는다.
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: edge }).ok, true);
  assert.equal(runGuard({ ...macChromeConfig(), chromeGuard: null }, { now: NOW, run, readTail: QUIET }).reason, "guard_n30_tick_unknown");
});

test("틱 창: 마지막 틱 ±60초(+drift 30초)와 브라우저 120초가 겹치면 쉼, retryAfter = 금지 구간 끝", () => {
  const { run } = chromeRun();
  const recent = logs({ scheduler: [[NOW - 30000, "tick"]], watchdog: [[NOW - 230000, "healthy"]] });
  assert.deepEqual(runGuard(macChromeConfig(), { now: NOW, run, readTail: recent }), { ok: false, mode: "n30-chrome", reason: "guard_n30_tick_window", retryAfterSec: 60 });
  // drift: 85초 전 틱은 +90초까지 금지 → 5초 남음
  const drift = logs({ scheduler: [[NOW - 85000, "tick"]], watchdog: [[NOW - 230000, "healthy"]] });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: drift }).retryAfterSec, 5);
  // 95초 전 틱은 지났다(다음 틱 505초 뒤 → 금지 시작 445초 뒤, 브라우저는 120초) → 통과
  const passed = logs({ scheduler: [[NOW - 95000, "tick"]], watchdog: [[NOW - 230000, "healthy"]] });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: passed }).ok, true);
  // 다음 틱이 100초 뒤(마지막 틱 500초 전) → 금지 시작 40초 뒤라 겹침 → 끝(190초 뒤)까지
  const upcoming = logs({ scheduler: [[NOW - 500000, "tick"]], watchdog: [[NOW - 230000, "healthy"]] });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: upcoming }).retryAfterSec, 190);
  assert.equal(isWaitableGuardReason("guard_n30_tick_window"), true);
  assert.equal(isWaitableGuardReason("guard_n30_chrome_missing"), false);
});

test("틱 창: 스케줄러 달력 시각(맥 현지 08:50·14:50)도 피한다", () => {
  const { run } = chromeRun();
  const at = new Date(2026, 9, 17, 8, 49, 0, 0).getTime();
  const quiet = logs({ scheduler: [[at - 200000, "tick"]], watchdog: [[at - 230000, "healthy"]] });
  const result = runGuard(macChromeConfig(), { now: at, run, readTail: quiet });
  assert.equal(result.reason, "guard_n30_tick_window");
  assert.equal(result.retryAfterSec, 150);
  const ticks = calendarTicks(at, ["08:50", "14:50"]);
  assert.equal(ticks.length, 4);
  assert.equal(new Date(ticks[0]).getHours(), 8);
  assert.equal(new Date(ticks[2]).getDate(), 18);
});

test("워치독 동기화 중: 420초 안의 동기화·재시작 줄이면 쉼(retryAfter = 줄 시각 + 420 − now)", () => {
  const { run } = chromeRun();
  // 줄 문구는 워치독 원문이 실제로 쓰는 모양이다(scripts/watchdog/mi-rank-watchdog.sh).
  const synced = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 230000, "healthy"], [NOW - 100000, "drift_sync_ok files=3"], [NOW - 100000, "sync_chrome_restart_begin"]] });
  assert.deepEqual(runGuard(macChromeConfig(), { now: NOW, run, readTail: synced }), { ok: false, mode: "n30-chrome", reason: "guard_n30_watchdog_busy", retryAfterSec: 320 });
  const restart = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 230000, "healthy"], [NOW - 400000, "restart_begin stalled_seconds=1830"]] });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: restart }).retryAfterSec, 20);
  for (const text of [
    "sync_source_fast_forwarded from=ea84f33 to=feca1e3", "sync_cooldown_bypassed reason=runtime_version_drift source=1.1.29 copy=1.1.28",
    "drift_sync_ok files=3", "drift_sync_failed status=timeout", "sync_chrome_restart_begin", "chrome_quit_failed status=1",
    "chrome_quit_incomplete", "chrome_profile_forwarded profile=Profile 5",
  ]) {
    // 뒤에 평범한 줄을 하나 더 둬서 (가) 줄 규칙만 본다((나) 마지막 줄 규칙은 아래 따로).
    const busy = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 230000, "healthy"], [NOW - 10000, text], [NOW - 9000, "healthy stalled_minutes=1"]] });
    assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: busy }).reason, "guard_n30_watchdog_busy", text);
  }
  // 쿨다운 중 릴리스 드리프트: sync_cooldown_bypassed 뒤 설치(최대 180초)가 이어진다 → 틱 창(+90초)이 지나도 줄 + 420초까지 쉰다.
  const bypassed = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 230000, "healthy"], [NOW - 100000, "sync_cooldown_bypassed reason=runtime_version_drift source=1.1.29 copy=1.1.28"]] });
  assert.deepEqual(runGuard(macChromeConfig(), { now: NOW, run, readTail: bypassed }), { ok: false, mode: "n30-chrome", reason: "guard_n30_watchdog_busy", retryAfterSec: 320 });
  // 동기화를 건너뛴 줄(drift_detected 는 늘 sync_skipped=…·sync_suppressed_cooldown 꼬리가 붙는다)·420초가 지난 줄은 쉬지 않는다.
  for (const text of [
    "drift_detected files=3 sync_skipped=repository_dirty", "drift_detected files=3 sync_skipped=collection_active",
    "drift_detected files=4 sync_suppressed_cooldown seconds_left=9030",
  ]) {
    const skipped = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 230000, "healthy"], [NOW - 100000, text]] });
    assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: skipped }).ok, true, text);
  }
  const stale = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 500000, "restart_begin stalled_seconds=1830"], [NOW - 230000, "healthy"]] });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: stale }).ok, true);
  assert.equal(isWaitableGuardReason("guard_n30_watchdog_busy"), true);
});

test("워치독 설치 구간(줄 없음): 앞 줄 없이 drift_sync_ok 가 나오는 실제 순서에서 설치 중에는 쉰다", () => {
  const { run } = chromeRun();
  // 2026-10-16 이 맥 로그 위상: 스케줄러 08:24:01, 워치독 08:18:31~32(runtime_in_sync·healthy), 다음 워치독 틱 S = 08:28:36.
  // 2026-09-28T01:10:39Z 처럼 sync_source_… 줄 없이 fetch + 설치가 돌면 drift_sync_ok 전까지 워치독은 한 줄도 쓰지 않는다.
  const S = NOW - 95000;
  const previous = [[S - 605000, "runtime_in_sync files=14"], [S - 604000, "healthy stalled_minutes=47"]];
  const scheduler = [[S - 275000, "tick"]];
  for (const offset of [88, 90, 95, 100, 120, 200, 280]) {
    const at = S + offset * 1000;
    const result = runGuard(macChromeConfig(), { now: at, run, readTail: logs({ scheduler, watchdog: previous }) });
    assert.equal(result.ok, false, `S+${offset}`);
    assert.equal(result.reason, "guard_n30_watchdog_busy", `S+${offset}`);
    assert.ok(result.retryAfterSec >= 1 && result.retryAfterSec <= 30, `S+${offset}: ${result.retryAfterSec}`);
  }
  // 설치가 끝나 drift_sync_ok·sync_chrome_restart_begin 이 같은 초에 찍히면 그 줄 + 420초까지 쉰다.
  const done = logs({ scheduler, watchdog: [...previous, [S + 200000, "drift_sync_ok files=3"], [S + 200000, "sync_chrome_restart_begin"]] });
  assert.equal(runGuard(macChromeConfig(), { now: S + 210000, run, readTail: done }).retryAfterSec, 410);
  // 같은 틱이 평소처럼 바로 줄을 쓰면(동기화 없음) 틱 창이 끝난 뒤 통과한다(오탐 없음).
  const normal = logs({ scheduler, watchdog: [...previous, [S + 2000, "runtime_in_sync files=14"], [S + 2000, "healthy stalled_minutes=57"]] });
  assert.deepEqual(runGuard(macChromeConfig(), { now: S + 95000, run, readTail: normal }), { ok: true, mode: "n30-chrome" });
  // 마지막 줄이 간격 + 300초보다 오래되면 2단계가 끝낸다(기다리지 않음).
  assert.equal(runGuard(macChromeConfig(), { now: S - 604000 + 901000, run, readTail: logs({ scheduler: [[S + 290000, "tick"]], watchdog: previous }) }).reason, "guard_n30_tick_unknown");
});

test("워치독 설치 구간(줄 없음): 마지막 줄이 fetch 뒤 줄(sync_source_…)이면 결론 줄이 나올 때까지 쉰다", () => {
  const { run } = chromeRun();
  const S = NOW - 160000;
  const previous = [[S - 605000, "runtime_in_sync files=14"], [S - 604000, "healthy stalled_minutes=47"]];
  const scheduler = [[S - 200000, "tick"]];
  for (const text of [
    "sync_source_fetch_failed status=timeout", "sync_source_fast_forward_failed status=1 local=be574b5 origin=f2679dd",
    "sync_source_behind action=none reason=diverged local=a origin=b", "sync_source_pull_skipped reason=not_on_main",
  ]) {
    // fetch 상한(60초) 뒤 줄 → 해시 대조 → 설치(줄 없음, 최대 180초). S+160 은 그 줄의 틱 창(+90초)이 지난 때다.
    const pending = logs({ scheduler, watchdog: [...previous, [S + 60000, text]] });
    assert.deepEqual(runGuard(macChromeConfig(), { now: NOW, run, readTail: pending }), { ok: false, mode: "n30-chrome", reason: "guard_n30_watchdog_busy", retryAfterSec: 30 }, text);
    // 결론 줄(runtime_in_sync)이 뒤따르면 그 틱에는 설치가 없다 → 통과(매 틱 not_on_main 이어도 계속 쉬지 않음).
    const concluded = logs({ scheduler, watchdog: [...previous, [S + 60000, text], [S + 60000, "runtime_in_sync files=14"], [S + 61000, "healthy stalled_minutes=57"]] });
    assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: concluded }).ok, true, text);
  }
});

test("readTail: 끝 4KB 만 읽기 전용으로 읽는다", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, "logs", "tail.log");
    fs.writeFileSync(file, `${"x".repeat(10000)}\n2026-10-17T02:00:00Z last line\n`);
    const text = readTail(file);
    assert.ok(text.length <= 4096);
    assert.ok(text.endsWith("last line\n"));
    const before = fs.readFileSync(file, "utf8");
    readTail(file);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.throws(() => readTail(path.join(root, "missing.log")));
  } finally {
    removeRoot(root);
  }
});

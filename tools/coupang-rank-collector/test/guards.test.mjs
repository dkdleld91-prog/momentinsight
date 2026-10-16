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

test("워치독 동기화 중: 420초 안의 drift_detected files=N·restart_begin 줄이면 쉼(retryAfter = 줄 시각 + 420 − now)", () => {
  const { run } = chromeRun();
  const drift = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 230000, "healthy"], [NOW - 100000, "drift_detected files=3"]] });
  assert.deepEqual(runGuard(macChromeConfig(), { now: NOW, run, readTail: drift }), { ok: false, mode: "n30-chrome", reason: "guard_n30_watchdog_busy", retryAfterSec: 320 });
  const restart = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 230000, "healthy"], [NOW - 400000, "restart_begin reason=stalled"]] });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: restart }).retryAfterSec, 20);
  for (const text of ["sync_source_fast_forwarded from=a to=b", "drift_sync_ok files=3", "sync_chrome_restart_begin", "chrome_quit_failed", "chrome_profile_forwarded profile=P"]) {
    const busy = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 230000, "healthy"], [NOW - 10000, text]] });
    assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: busy }).reason, "guard_n30_watchdog_busy", text);
  }
  // 동기화를 건너뛴 줄·420초가 지난 줄은 쉬지 않는다.
  const skipped = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 230000, "healthy"], [NOW - 100000, "drift_detected files=3 sync_skipped=repository_dirty"]] });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: skipped }).ok, true);
  const stale = logs({ scheduler: [[NOW - 200000, "tick"]], watchdog: [[NOW - 500000, "restart_begin"], [NOW - 230000, "healthy"]] });
  assert.equal(runGuard(macChromeConfig(), { now: NOW, run, readTail: stale }).ok, true);
  assert.equal(isWaitableGuardReason("guard_n30_watchdog_busy"), true);
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

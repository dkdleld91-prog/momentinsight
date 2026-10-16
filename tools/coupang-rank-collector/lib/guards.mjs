// 맥 + Chrome(예비 경로)일 때 N30 보호 판정(명세 §9.2 lib/guards.mjs). Edge 면 늘 통과한다(윈도우는 늘 Edge).
// 판단할 수 없으면 닫히는 쪽(쉼)을 택한다. 다른 프로세스를 끄거나 바꾸지 않고 읽기만 한다:
// pgrep -x(실행 파일 이름 정확 일치)·ps -o command= 로 확인하고, 설치기가 collector.json 에 적어 준 로그 두 개를 "r" 로만 연다.
// 로그 경로·라벨은 이 파일에 두지 않는다(M8).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { BROWSER_HARD_CAP_SECONDS } from "./contract.mjs";

export const TAIL_BYTES = 4096;
export const TICK_STALE_EXTRA_SECONDS = 300;
export const TICK_LOOKAHEAD = 3;
// 워치독 줄은 N30 워치독 원문이 실제로 쓰는 것만 맞춘다(2026-10-16 원문·이 맥 로그 확인, 읽기만 함).
// 동기화 틱의 순서: fetch(최대 60초) → [sync_source_… 줄, 있을 때만] → 해시 대조 → [sync_cooldown_bypassed, 쿨다운 중
// 릴리스 드리프트일 때만] → 설치(최대 180초, 이 동안 줄 없음) → drift_sync_ok|drift_sync_failed → sync_chrome_restart_begin
// → quit → 8초 → chrome_… 줄. 드리프트 검사는 결론 줄 하나(runtime_in_sync, drift_detected … sync_skipped=…·
// sync_suppressed_cooldown …, sync_check_failed …, drift_sync_…)로 끝난다. drift_detected 는 건너뛸 때만 쓰이므로 쉼 신호가 아니다.
// (가) 아래 줄이 420초 안에 있으면 쉰다.
export const WATCHDOG_BUSY_PATTERN = / (sync_source_fast_forwarded|sync_cooldown_bypassed|drift_sync_|sync_chrome_restart_begin|restart_begin|chrome_quit|chrome_profile_forward)/;
// (나) 워치독의 마지막 줄이 fetch 뒤 줄(sync_source_…)·sync_cooldown_bypassed 이면 드리프트 검사가 아직 결론을 쓰지 않은
//     것이라 설치가 돌고 있을 수 있다. 다음 줄이 나올 때까지 쉰다.
export const WATCHDOG_PENDING_PATTERN = / (sync_source_|sync_cooldown_bypassed)/;
// (다) 다음 틱의 줄이 예상 틱 창(마지막 줄 + 간격 + margin + drift)이 지나도록 없으면 설치가 조용히 돌고 있을 수 있다
//     (앞 줄 없이 drift_sync_ok 가 바로 나오는 경로, 2026-09-28T01:10:39Z 실측). 다음 줄이 나올 때까지 쉰다.
// (나)·(다)는 끝을 알 수 없으므로 짧게 다시 본다. 마지막 줄이 간격 + 300초보다 오래되면 2단계가 guard_n30_tick_unknown 으로 끝낸다.
export const WATCHDOG_RECHECK_SECONDS = 30;
const TICK_LINE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) /;
const WAITABLE = new Set(["guard_n30_tick_window", "guard_n30_watchdog_busy"]);

export function isWaitableGuardReason(reason) {
  return WAITABLE.has(reason);
}

// 로그 끝 4KB 를 읽기 전용으로 읽는다.
export function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function defaultRun(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
}

export function tickLines(text) {
  const lines = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(TICK_LINE_PATTERN);
    if (!match) continue;
    const at = Date.parse(match[1]);
    if (Number.isFinite(at)) lines.push({ at, line });
  }
  return lines;
}

export function lastTick(text) {
  const lines = tickLines(text);
  return lines.length ? lines[lines.length - 1].at : null;
}

// N30 본체 크롬: pgrep -x 로 실행 파일 이름이 정확히 같은 PID 를 얻고, --user-data-dir=·--type= 이 없는 것이 하나라도 있어야 한다.
export function hasN30MainChrome(run = defaultRun) {
  let output;
  try {
    output = run("/usr/bin/pgrep", ["-x", "Google Chrome"]);
  } catch {
    return false;
  }
  const pids = String(output || "").split(/\s+/).filter((item) => /^[0-9]{1,10}$/.test(item));
  for (const pid of pids) {
    let commandLine;
    try {
      commandLine = String(run("/bin/ps", ["-o", "command=", "-p", pid]) || "").trim();
    } catch {
      continue;
    }
    if (commandLine && !/--user-data-dir=/.test(commandLine) && !/--type=/.test(commandLine)) return true;
  }
  return false;
}

export function calendarTicks(now, times) {
  const ticks = [];
  for (const offset of [0, 1]) {
    for (const clock of times || []) {
      const [hour, minute] = String(clock).split(":").map(Number);
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;
      const date = new Date(now);
      date.setDate(date.getDate() + offset);
      date.setHours(hour, minute, 0, 0);
      ticks.push(date.getTime());
    }
  }
  return ticks;
}

function wait(mode, reason, untilMs, now) {
  return { ok: false, mode, reason, retryAfterSec: Math.max(1, Math.ceil((untilMs - now) / 1000)) };
}

export function runGuard(config, { now = Date.now(), run = defaultRun, readTail: read = readTail, browserSeconds = BROWSER_HARD_CAP_SECONDS } = {}) {
  if (config?.browser?.kind === "edge") return { ok: true, mode: "none" };
  const mode = "n30-chrome";
  const guard = config?.chromeGuard;
  if (!guard) return { ok: false, mode, reason: "guard_n30_tick_unknown" };

  // 1. N30 본체 크롬
  if (!hasN30MainChrome(run)) return { ok: false, mode, reason: "guard_n30_chrome_missing" };

  // 2. 마지막 틱 시각(두 로그 모두)
  let schedulerText;
  let watchdogText;
  try {
    schedulerText = read(guard.schedulerLog, TAIL_BYTES);
    watchdogText = read(guard.watchdogLog, TAIL_BYTES);
  } catch {
    return { ok: false, mode, reason: "guard_n30_tick_unknown" };
  }
  const staleMs = (guard.intervalSeconds + TICK_STALE_EXTRA_SECONDS) * 1000;
  const lastTicks = [lastTick(schedulerText), lastTick(watchdogText)];
  if (lastTicks.some((at) => at === null || now - at > staleMs)) return { ok: false, mode, reason: "guard_n30_tick_unknown" };

  // 3. 워치독 동기화 중(M5)
  // (가) 420초 안의 동기화·재시작 줄
  const busyMs = guard.watchdogBusySeconds * 1000;
  const watchdogLines = tickLines(watchdogText);
  let busyUntil = null;
  for (const entry of watchdogLines) {
    if (now - entry.at < 0 || now - entry.at > busyMs) continue;
    if (!WATCHDOG_BUSY_PATTERN.test(entry.line)) continue;
    busyUntil = Math.max(busyUntil ?? 0, entry.at + busyMs);
  }
  if (busyUntil !== null) return wait(mode, "guard_n30_watchdog_busy", busyUntil, now);
  // (나) 마지막 줄이 결론 전 줄, (다) 다음 틱 줄이 늦음 → 다음 줄이 나올 때까지(짧게 다시 본다)
  const watchdogLast = watchdogLines[watchdogLines.length - 1];
  const overdueMs = (guard.intervalSeconds + guard.marginSeconds + guard.driftSeconds) * 1000;
  if (WATCHDOG_PENDING_PATTERN.test(watchdogLast.line) || now - watchdogLast.at > overdueMs) {
    return wait(mode, "guard_n30_watchdog_busy", Math.min(now + WATCHDOG_RECHECK_SECONDS * 1000, watchdogLast.at + staleMs + 1000), now);
  }

  // 4. 틱 창 회피: 브라우저가 떠 있을 [now, now+120초] 이 [S−60초, S+60초+30초] 와 겹치면 쉰다.
  const ticks = [];
  for (const at of lastTicks) {
    for (let k = 0; k < TICK_LOOKAHEAD; k += 1) ticks.push(at + k * guard.intervalSeconds * 1000);
  }
  ticks.push(...calendarTicks(now, guard.calendarLocalTimes));
  const windowEnd = now + browserSeconds * 1000;
  let blockedUntil = null;
  for (const tick of ticks) {
    const forbiddenStart = tick - guard.marginSeconds * 1000;
    const forbiddenEnd = tick + (guard.marginSeconds + guard.driftSeconds) * 1000;
    if (now <= forbiddenEnd && windowEnd >= forbiddenStart) blockedUntil = Math.max(blockedUntil ?? 0, forbiddenEnd);
  }
  if (blockedUntil !== null) return wait(mode, "guard_n30_tick_window", blockedUntil, now);
  return { ok: true, mode };
}

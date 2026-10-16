import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PROFILE_DIR_PATTERN } from "../lib/contract.mjs";
import {
  assertSafeProfileDir, browserArgs, cleanEnv, closeBrowser, countProfileDirs, isOurBrowserCommandLine, killOrphanBrowser,
  launchBrowser, makeProfileDir, parseBrowserVersion, readBrowserVersionFile, readDevToolsActivePort, sweepStaleProfiles,
  writeBrowserVersionFile,
} from "../lib/browser.mjs";
import { nullLogger } from "../lib/log.mjs";
import { MAC_EDGE_CONFIG, WINDOWS_CONFIG, fakeChild, fakeClock, removeRoot, tempRoot } from "./helpers.mjs";

test("실행 인자: 창 방식별 위치, 고정 포트 없음, 맥만 mock-keychain, 마지막은 about:blank", () => {
  const profileDir = "/root/runs/mi-coupang-run-1760000000000-0a1b2c3d";
  const normal = browserArgs({ profileDir, windowMode: "normal", platform: "windows" });
  assert.deepEqual(normal, [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate,CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--window-size=1280,900",
    "--window-position=0,0",
    "about:blank",
  ]);
  assert.ok(browserArgs({ profileDir, windowMode: "offscreen", platform: "windows" }).includes("--window-position=-2400,-2400"));
  assert.ok(browserArgs({ profileDir, windowMode: "minimized", platform: "windows" }).includes("--window-position=0,0"));
  const mac = browserArgs({ profileDir, windowMode: "offscreen", platform: "macos" });
  assert.equal(mac.at(-2), "--use-mock-keychain");
  assert.equal(mac.at(-1), "about:blank");
  assert.ok(!normal.includes("--use-mock-keychain"));
});

test("프로필 폴더: runs 바로 아래, 이름 규칙, 브라우저 기본 사용자 폴더 거절", () => {
  const root = tempRoot();
  try {
    const dir = makeProfileDir(root, { now: () => 1760000000000, random: () => "0a1b2c3d" });
    assert.equal(path.basename(dir), "mi-coupang-run-1760000000000-0a1b2c3d");
    assert.ok(PROFILE_DIR_PATTERN.test(path.basename(dir)));
    assert.ok(fs.statSync(dir).isDirectory());
    assert.equal(assertSafeProfileDir(dir, root), path.resolve(dir));
    assert.throws(() => assertSafeProfileDir(path.join(root, "mi-coupang-run-1760000000000-0a1b2c3d"), root));
    assert.throws(() => assertSafeProfileDir(path.join(root, "runs", "other"), root));
    assert.throws(() => assertSafeProfileDir(path.join(root, "runs", "x", "mi-coupang-run-1760000000000-0a1b2c3d"), root));
    assert.throws(() => assertSafeProfileDir(path.join(root, "runs", "..", "mi-coupang-run-1760000000000-0a1b2c3d"), root));
    const chromeRoot = "/Users/a/Library/Application Support/Google/Chrome/CoupangRank";
    assert.throws(() => assertSafeProfileDir(`${chromeRoot}/runs/mi-coupang-run-1760000000000-0a1b2c3d`, chromeRoot));
    const edgeRoot = "/Users/a/Library/Application Support/Microsoft Edge/CoupangRank";
    assert.throws(() => assertSafeProfileDir(`${edgeRoot}/runs/mi-coupang-run-1760000000000-0a1b2c3d`, edgeRoot));
    const winRoot = "C:\\Users\\a\\AppData\\Local\\MomentInsight\\CoupangRank";
    assert.ok(assertSafeProfileDir(`${winRoot}\\runs\\mi-coupang-run-1760000000000-0a1b2c3d`, winRoot, { pathImpl: path.win32 }));
    const userData = "C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\User Data";
    assert.throws(() => assertSafeProfileDir(`${userData}\\runs\\mi-coupang-run-1760000000000-0a1b2c3d`, userData, { pathImpl: path.win32 }));
  } finally {
    removeRoot(root);
  }
});

test("cleanEnv: MI_ 로 시작하는 키(대소문자 무시)를 모두 뺀다", () => {
  const env = { PATH: "/bin", MI_COUPANG_COLLECTOR_TOKEN: "mic1_x", mi_other: "y", Mi_Mixed: "z", HOME: "/h", XMI_KEEP: "1" };
  assert.deepEqual(cleanEnv(env), { PATH: "/bin", HOME: "/h", XMI_KEEP: "1" });
});

test("launchBrowser: 토큰 없는 환경, stdio ignore, 맥만 detached, browser.pid 기록", () => {
  const root = tempRoot();
  try {
    const calls = [];
    const child = fakeChild({ pid: 5151 });
    const spawnImpl = (file, args, options) => { calls.push({ file, args, options }); return child; };
    const profileDir = makeProfileDir(root);
    launchBrowser({ config: WINDOWS_CONFIG, profileDir, root, windowMode: "offscreen", spawnImpl, env: { PATH: "x", MI_COUPANG_COLLECTOR_TOKEN: "secret" }, now: () => 1760000000000 });
    assert.equal(calls[0].file, WINDOWS_CONFIG.browser.path);
    assert.equal(calls[0].options.detached, false);
    assert.equal(calls[0].options.stdio, "ignore");
    assert.deepEqual(calls[0].options.env, { PATH: "x" });
    assert.ok(calls[0].args.includes("--window-position=-2400,-2400"));
    const record = JSON.parse(fs.readFileSync(path.join(root, "state", "browser.pid"), "utf8"));
    assert.deepEqual(record, { pid: 5151, profileDir, startedAt: "2025-10-09T08:53:20.000Z" });
    launchBrowser({ config: MAC_EDGE_CONFIG, profileDir, root, windowMode: "normal", spawnImpl, env: {} });
    assert.equal(calls[1].options.detached, true);
    assert.throws(() => launchBrowser({ config: WINDOWS_CONFIG, profileDir, root, windowMode: "normal", spawnImpl: () => fakeChild({ pid: null }) }), (error) => error.code === "browser_launch_failed");
    assert.throws(() => launchBrowser({ config: WINDOWS_CONFIG, profileDir: path.join(root, "elsewhere"), root, windowMode: "normal", spawnImpl }), (error) => error.code === "profile_dir_unsafe");
  } finally {
    removeRoot(root);
  }
});

test("DevToolsActivePort: 파일이 생기면 ws 주소, 20초 안에 없으면 devtools_port_timeout, 먼저 꺼지면 browser_exit_early", async () => {
  const root = tempRoot();
  try {
    const profileDir = makeProfileDir(root);
    const clock = fakeClock();
    let polls = 0;
    const sleep = async (ms) => {
      polls += 1;
      await clock.sleep(ms);
      if (polls === 3) fs.writeFileSync(path.join(profileDir, "DevToolsActivePort"), "51234\n/devtools/browser/0b1c-2d3e\n");
    };
    const url = await readDevToolsActivePort(profileDir, 20000, { sleep, now: clock.now });
    assert.equal(url, "ws://127.0.0.1:51234/devtools/browser/0b1c-2d3e");
    assert.deepEqual(clock.sleeps, [200, 200, 200]);

    const other = makeProfileDir(root);
    const clock2 = fakeClock();
    await assert.rejects(readDevToolsActivePort(other, 20000, { sleep: clock2.sleep, now: clock2.now }), (error) => error.code === "devtools_port_timeout");
    assert.equal(clock2.now() - fakeClock().now(), 20000);

    const child = fakeChild();
    child.exit(1);
    await assert.rejects(readDevToolsActivePort(other, 20000, { child, sleep: clock2.sleep, now: clock2.now }), (error) => error.code === "browser_exit_early");
    fs.writeFileSync(path.join(other, "DevToolsActivePort"), "not-a-port\n/devtools/browser/x\n");
    const clock3 = fakeClock();
    await assert.rejects(readDevToolsActivePort(other, 1000, { sleep: clock3.sleep, now: clock3.now }), (error) => error.code === "devtools_port_timeout");
  } finally {
    removeRoot(root);
  }
});

test("closeBrowser: Browser.close → 5초 기다림 → 안 꺼지면 PID 트리만 종료 → 프로필 삭제 → browser.pid 삭제", async () => {
  const root = tempRoot();
  try {
    const profileDir = makeProfileDir(root);
    fs.writeFileSync(path.join(profileDir, "Local State"), "{}");
    fs.writeFileSync(path.join(root, "state", "browser.pid"), JSON.stringify({ pid: 1 }));
    const order = [];
    const child = fakeChild({ pid: 777 });
    const conn = { closed: false, send: async (method) => { order.push(`send:${method}`); return {}; }, close: () => order.push("conn.close") };
    const result = await closeBrowser({
      child, conn, platform: "windows", profileDir, root, log: nullLogger(), waitMs: 20,
      deps: { killTree: (pid) => { order.push(`kill:${pid}`); child.exit(1); return true; } },
    });
    assert.deepEqual(order, ["send:Browser.close", "kill:777", "conn.close"]);
    assert.deepEqual(result, { killed: true, cleanupFailed: false });
    assert.equal(fs.existsSync(profileDir), false);
    assert.equal(fs.existsSync(path.join(root, "state", "browser.pid")), false);

    // 정상 종료면 종료 명령을 쓰지 않는다.
    const calm = fakeChild({ pid: 778 });
    const calmConn = { closed: false, send: async () => { setImmediate(() => calm.exit(0)); return {}; }, close: () => {} };
    const killed = [];
    const calmResult = await closeBrowser({ child: calm, conn: calmConn, platform: "macos", profileDir: makeProfileDir(root), root, log: nullLogger(), waitMs: 500, deps: { killTree: (pid) => killed.push(pid) } });
    assert.deepEqual(killed, []);
    assert.equal(calmResult.killed, false);
  } finally {
    removeRoot(root);
  }
});

test("closeBrowser: 프로필 삭제가 실패해도 예외를 내지 않고 결과만 표시(profile_cleanup_failed 기록)", async () => {
  const root = tempRoot();
  try {
    const profileDir = makeProfileDir(root);
    const log = nullLogger();
    const child = fakeChild();
    child.exit(0);
    const result = await closeBrowser({
      child, conn: null, platform: "windows", profileDir, root, log, waitMs: 10,
      deps: { rmSync: () => { const error = new Error("busy"); error.code = "EBUSY"; throw error; } },
    });
    assert.equal(result.cleanupFailed, true);
    assert.ok(log.lines.some((line) => / profile_cleanup_failed code=EBUSY/.test(line)));
  } finally {
    removeRoot(root);
  }
});

test("killOrphanBrowser: browser.pid 의 명령줄에 우리 runs 폴더가 있을 때만 끈다", () => {
  const root = tempRoot();
  try {
    const pidFile = path.join(root, "state", "browser.pid");
    const killed = [];
    const killTree = (pid, platform) => { killed.push([pid, platform]); return true; };
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 4242, profileDir: "x" }));
    const log = nullLogger();
    const ours = killOrphanBrowser(root, log, {
      platform: "windows",
      readCommandLine: () => "\"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\" --user-data-dir=C:\\Users\\a\\AppData\\Local\\momentinsight\\coupangrank\\RUNS\\mi-coupang-run-1-a",
      killTree,
    });
    assert.equal(ours.killed, true);
    assert.deepEqual(killed, [[4242, "windows"]]);
    assert.ok(log.lines.some((line) => / browser_orphan_killed pid=4242/.test(line)));
    assert.equal(fs.existsSync(pidFile), false);

    fs.writeFileSync(pidFile, JSON.stringify({ pid: 4343 }));
    const other = killOrphanBrowser(root, log, { platform: "macos", readCommandLine: () => "/Applications/Some.app/Contents/MacOS/Some --user-data-dir=/tmp/x", killTree });
    assert.equal(other.killed, false);
    assert.equal(killed.length, 1);
    assert.equal(fs.existsSync(pidFile), false);

    fs.writeFileSync(pidFile, JSON.stringify({ pid: 4444 }));
    const mac = killOrphanBrowser(root, log, {
      platform: "macos",
      readCommandLine: () => "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --user-data-dir=/Users/a/Library/Application Support/MomentInsight/CoupangRank/runs/mi-coupang-run-1-b",
      killTree,
    });
    assert.equal(mac.killed, true);
    assert.equal(killOrphanBrowser(root, log, { platform: "macos", readCommandLine: () => { throw new Error("no"); }, killTree }).killed, false);
  } finally {
    removeRoot(root);
  }
});

test("isOurBrowserCommandLine: 윈도우는 대소문자 무시, 맥은 정확히", () => {
  assert.equal(isOurBrowserCommandLine("x \\MomentInsight\\CoupangRank\\runs\\y", "windows"), true);
  assert.equal(isOurBrowserCommandLine("x \\momentinsight\\coupangrank\\runs\\y", "windows"), true);
  assert.equal(isOurBrowserCommandLine("x \\MomentInsight\\NaverShop\\runs\\y", "windows"), false);
  assert.equal(isOurBrowserCommandLine("x /MomentInsight/CoupangRank/runs/y", "macos"), true);
  assert.equal(isOurBrowserCommandLine("x /MomentInsight/CoupangRank/app/y", "macos"), false);
  assert.equal(isOurBrowserCommandLine("", "macos"), false);
});

test("sweepStaleProfiles: 1시간 지난 우리 폴더만 지운다(다른 이름·새 폴더는 둔다)", () => {
  const root = tempRoot();
  try {
    const now = 1760000000000;
    const old = path.join(root, "runs", `mi-coupang-run-${now - 3600001}-aaaaaaaa`);
    const fresh = path.join(root, "runs", `mi-coupang-run-${now - 60000}-bbbbbbbb`);
    const foreign = path.join(root, "runs", "keep-me");
    for (const dir of [old, fresh, foreign]) fs.mkdirSync(dir, { recursive: true });
    assert.equal(countProfileDirs(root), 2);
    assert.equal(sweepStaleProfiles(root, now), 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(foreign), true);
    assert.equal(sweepStaleProfiles(root, now, { rmSync: () => { throw new Error("locked"); } }), 0);
  } finally {
    removeRoot(root);
  }
});

test("브라우저 버전: Edge 는 Edg/ 값, 그 밖은 product 숫자, state/browser-version 읽기·쓰기", () => {
  assert.equal(parseBrowserVersion({ product: "Chrome/141.0.7390.55", userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Edg/141.0.3537.71" }, "edge"), "141.0.3537.71");
  assert.equal(parseBrowserVersion({ product: "Edg/141.0.3537.71", userAgent: "" }, "edge"), "141.0.3537.71");
  assert.equal(parseBrowserVersion({ product: "Chrome/141.0.7390.55" }, "chrome"), "141.0.7390.55");
  assert.equal(parseBrowserVersion({}, "chrome"), "unknown");
  const root = tempRoot();
  try {
    assert.equal(readBrowserVersionFile(root), "unknown");
    assert.equal(writeBrowserVersionFile(root, "141.0.3537.71"), true);
    assert.equal(readBrowserVersionFile(root), "141.0.3537.71");
    assert.equal(writeBrowserVersionFile(root, "unknown"), false);
    fs.writeFileSync(path.join(root, "state", "browser-version"), `${String.fromCharCode(0xfeff)}142.0.1.2\r\n`);
    assert.equal(readBrowserVersionFile(root), "142.0.1.2");
  } finally {
    removeRoot(root);
  }
});

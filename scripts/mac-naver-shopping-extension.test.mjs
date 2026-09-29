import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 1.1.34 배포 절차 3): 맥 수집 프로필의 chrome://extensions 를 **새 창 하나**로 열고 그 창(id)만 옮긴다.
// 09-29 에는 두 번째 단계가 front window 의 활성 탭 주소를 무조건 바꿔 대표의 다른 탭을 덮을 수 있었다.
// 대표의 실제 Chrome 에는 절대 돌리지 않는다: osascript·pgrep·Chrome 실행 파일을 모두 스텁으로 바꾸고 가짜 HOME 에서 돈다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "mac-naver-shopping-extension.sh");
const source = fs.readFileSync(script, "utf8");
const code = source.split("\n").filter((line) => !/^\s*#/u.test(line)).join("\n");
const EXTENSION_ID = "pflggephankeefaeoaafkmggampnaefm";
const EXTENSION_URL = `chrome://extensions/?id=${EXTENSION_ID}`;
// 맥 워치독이 호스트(수집 중)를 알아보는 pgrep 패턴과 같아야 한다.
const watchdog = fs.readFileSync(path.join(root, "scripts", "watchdog", "mi-rank-watchdog.sh"), "utf8");
const HOST_PGREP_PATTERN = "naver-shopping-native-host\\.mjs";

const STUBS = {
  osascript: `#!/bin/bash
script="$2"
printf '%s\\n' "$script" >> "$STUB_DIR/osascript.log"
case "$script" in
  *"get id of every window"*) [[ -f "$STUB_DIR/osascript-fail" ]] && exit 1; paste -s -d , "$STUB_DIR/windows" | sed 's/,/, /g' ;;
  *"get {URL of active tab of window id "*) cat "$STUB_DIR/new-window-state" 2>/dev/null || echo "about:blank, false" ;;
  *"set URL of active tab of window id "*) printf '%s\\n' "$script" >> "$STUB_DIR/navigated" ;;
  *"get URL of active tab of window id "*) echo "${EXTENSION_URL}" ;;
  *) exit 1 ;;
esac
`,
  // 인자 전체가 정확히 같을 때만 "실행 중"이라 답한다(패턴이 깨지면 호스트를 못 찾는 실제 pgrep 처럼 1).
  pgrep: `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_DIR/pgrep.log"
case "$*" in
  '-x Google Chrome') [[ -f "$STUB_DIR/chrome-running" ]] ;;
  '-f ${HOST_PGREP_PATTERN}') [[ -f "$STUB_DIR/host-running" ]] ;;
  *) exit 1 ;;
esac
`,
  chrome: `#!/bin/bash
printf '%s\\n' "$@" >> "$STUB_DIR/chrome-args"
[[ -f "$STUB_DIR/opens" ]] && cat "$STUB_DIR/opens" >> "$STUB_DIR/windows"
exit 0
`,
};

function fixture(t, { registered = "1.1.33", disk = "1.1.34", extensionListed = true, windows = ["101", "102"], opens = ["103"], chromeRunning = true, hostRunning = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mi-mac-extension-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stubDir = path.join(home, "stubs");
  const app = path.join(home, "Applications", "Google Chrome.app");
  const support = path.join(home, "Library", "Application Support");
  const extension = path.join(home, "unpacked extension");
  const profile = path.join(support, "Google", "Chrome", "Profile 5");
  for (const directory of [stubDir, path.join(app, "Contents", "MacOS"), path.join(support, "MomentInsight"), extension, profile]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const executable = (file, body) => { fs.writeFileSync(file, body); fs.chmodSync(file, 0o755); };
  executable(path.join(stubDir, "osascript"), STUBS.osascript);
  executable(path.join(stubDir, "pgrep"), STUBS.pgrep);
  executable(path.join(app, "Contents", "MacOS", "Google Chrome"), STUBS.chrome);
  fs.writeFileSync(path.join(support, "MomentInsight", "naver-shopping-chrome-scheduler.conf"), `${app}\nProfile 5\n`);
  if (disk !== null) fs.writeFileSync(path.join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, version: disk }));
  // Chrome 이 쓰는 모양(키 정렬·한 줄) 그대로: 다른 확장이 뒤에 있어도 우리 확장만 읽는다.
  // registered: null = 등록 정보 없음, disk: null = 디스크 manifest 없음, extensionListed: false = 우리 확장 항목 없음.
  const ours = { location: 4, path: extension, ...(registered === null ? {} : { service_worker_registration_info: { version: registered } }) };
  fs.writeFileSync(path.join(profile, "Secure Preferences"), JSON.stringify({
    extensions: { settings: {
      ...(extensionListed ? { [EXTENSION_ID]: ours } : {}),
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { path: "/elsewhere", service_worker_registration_info: { version: "9.9.9" } },
    } },
    protection: { macs: { extensions: { settings: { [EXTENSION_ID]: "ABCDEF" } } } },
  }));
  fs.writeFileSync(path.join(stubDir, "windows"), windows.map((id) => `${id}\n`).join(""));
  if (opens.length) fs.writeFileSync(path.join(stubDir, "opens"), opens.map((id) => `${id}\n`).join(""));
  if (chromeRunning) fs.writeFileSync(path.join(stubDir, "chrome-running"), "");
  if (hostRunning) fs.writeFileSync(path.join(stubDir, "host-running"), "");
  const run = (mode) => spawnSync("bash", [script, mode], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      STUB_DIR: stubDir,
      MI_OSASCRIPT: path.join(stubDir, "osascript"),
      MI_PGREP: path.join(stubDir, "pgrep"),
      MI_NODE: process.execPath,
      MI_WINDOW_POLLS: "1",
      MI_WINDOW_POLL_SECONDS: "0.05",
    },
  });
  const readStub = (name) => (fs.existsSync(path.join(stubDir, name)) ? fs.readFileSync(path.join(stubDir, name), "utf8") : "");
  return { run, readStub, stubDir };
}

test("the script never addresses the front window and navigates only by window id", () => {
  assert.doesNotMatch(code, /front window|active tab of window 1\b|window index/u);
  const navigations = [...code.matchAll(/set URL of ([^"\\]+)/gu)].map((match) => match[1].trim());
  assert.deepEqual(navigations, ["active tab of window id ${window_id} to"]);
  // 창 id 는 실행 전후 목록의 차이로만 얻는다.
  assert.ok(code.indexOf('before="$(window_ids)"') < code.indexOf('"${CHROME_EXECUTABLE}" "--profile-directory=${PROFILE_DIRECTORY}" --new-window'));
});

test("check reads the registered service worker against the disk manifest without touching Chrome", (t) => {
  const stale = fixture(t);
  const result = stale.run("check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "SW_VERSION=1.1.33 DISK_VERSION=1.1.34 PROFILE=Profile_5 VERDICT=STALE");
  assert.equal(stale.readStub("osascript.log"), "");
  assert.equal(stale.readStub("chrome-args"), "");
  const current = fixture(t, { registered: "1.1.34" });
  assert.equal(current.run("check").stdout.trim(), "SW_VERSION=1.1.34 DISK_VERSION=1.1.34 PROFILE=Profile_5 VERDICT=OK");
});

test("open makes one new window in the configured profile and moves only that window id to the extensions page", (t) => {
  const f = fixture(t);
  const result = f.run("open");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /VERDICT=STALE/u);
  assert.match(result.stdout, new RegExp(`OPENED window_id=103 profile=Profile_5 url=${EXTENSION_URL.replace(/[?.]/gu, "\\$&")}`, "u"));
  assert.deepEqual(f.readStub("chrome-args").trim().split("\n"), [
    "--profile-directory=Profile 5", "--new-window", "--no-first-run", "--no-default-browser-check", "about:blank",
  ]);
  assert.equal(f.readStub("navigated").trim(), `tell application "Google Chrome" to set URL of active tab of window id 103 to "${EXTENSION_URL}"`);
  assert.doesNotMatch(f.readStub("osascript.log"), /front window|window id 10[12]\b/u);
});

test("open moves nothing when the new window cannot be identified as its own", (t) => {
  const cases = [
    { name: "no new window", options: { opens: [] }, code: 6, marker: /NO_NEW_WINDOW/u },
    { name: "two new windows", options: { opens: ["103", "104"] }, code: 6, marker: /AMBIGUOUS_NEW_WINDOWS ids=103,104/u },
    { name: "window list unreadable", options: {}, failList: true, code: 5, marker: /WINDOW_LIST_FAILED/u },
    { name: "someone else's new tab page", options: {}, state: "chrome://newtab/, false", code: 6, marker: /NOT_OUR_WINDOW window_id=103/u },
    { name: "minimized collection window", options: {}, state: "about:blank, true", code: 6, marker: /NOT_OUR_WINDOW window_id=103/u },
  ];
  for (const { name, options, failList, state, code, marker } of cases) {
    const f = fixture(t, options);
    if (failList) fs.writeFileSync(path.join(f.stubDir, "osascript-fail"), "");
    if (state) fs.writeFileSync(path.join(f.stubDir, "new-window-state"), `${state}\n`);
    const result = f.run("open");
    assert.equal(result.status, code, `${name}: ${result.stdout}`);
    assert.match(result.stdout, marker, name);
    assert.equal(f.readStub("navigated"), "", `${name} must not navigate`);
  }
});

test("open does not start Chrome, does not open while a host runs, and does nothing when already current", (t) => {
  const off = fixture(t, { chromeRunning: false });
  const offResult = off.run("open");
  assert.equal(offResult.status, 4);
  assert.match(offResult.stdout, /CHROME_NOT_RUNNING/u);
  const busy = fixture(t, { hostRunning: true });
  const busyResult = busy.run("open");
  assert.equal(busyResult.status, 3);
  assert.match(busyResult.stdout, /HOST_RUNNING/u);
  assert.equal(busy.readStub("pgrep.log").split("\n")[0], `-f ${HOST_PGREP_PATTERN}`);
  const current = fixture(t, { registered: "1.1.34" });
  const currentResult = current.run("open");
  assert.equal(currentResult.status, 0);
  assert.match(currentResult.stdout, /ALREADY_CURRENT/u);
  for (const f of [off, busy, current]) {
    assert.equal(f.readStub("chrome-args"), "");
    assert.equal(f.readStub("osascript.log"), "");
  }
});

test("open refuses when the registered service worker cannot be read (UNKNOWN is not STALE)", (t) => {
  const cases = [
    { name: "no service_worker_registration_info", options: { registered: null }, verdict: "SW_VERSION= DISK_VERSION=1.1.34 PROFILE=Profile_5 VERDICT=UNKNOWN" },
    { name: "extension not in Secure Preferences", options: { extensionListed: false }, verdict: "SW_VERSION= DISK_VERSION= PROFILE=Profile_5 VERDICT=UNKNOWN reason=extension_not_found" },
    { name: "disk manifest missing", options: { disk: null }, verdict: "SW_VERSION=1.1.33 DISK_VERSION= PROFILE=Profile_5 VERDICT=UNKNOWN" },
  ];
  for (const { name, options, verdict } of cases) {
    const f = fixture(t, options);
    assert.equal(f.run("check").stdout.trim(), verdict, name);
    const result = f.run("open");
    assert.equal(result.status, 7, `${name}: ${result.stdout}`);
    assert.match(result.stdout, /SW_UNKNOWN/u, name);
    assert.doesNotMatch(result.stdout, /OPENED/u, name);
    assert.equal(f.readStub("chrome-args"), "", `${name} must not open a window`);
    assert.equal(f.readStub("osascript.log"), "", `${name} must not script Chrome`);
    assert.equal(f.readStub("navigated"), "", `${name} must not navigate`);
  }
});

test("the host guard uses the watchdog's pgrep pattern, which matches the running native host", () => {
  const patternsIn = (text) => [...text.matchAll(/pgrep\S* -f '([^']+)'/giu)].map((match) => match[1]);
  assert.deepEqual(patternsIn(code), [HOST_PGREP_PATTERN]);
  assert.ok(patternsIn(watchdog).includes(HOST_PGREP_PATTERN), "scripts/watchdog/mi-rank-watchdog.sh");
  // pgrep -f 는 전체 명령줄에 확장 정규식을 맞춘다.
  const host = new RegExp(HOST_PGREP_PATTERN, "u");
  assert.ok(host.test("/opt/homebrew/bin/node /Users/owner/Library/Application Support/MomentInsight/NaverShoppingBridge/naver-shopping-native-host.mjs chrome-extension://pflggephankeefaeoaafkmggampnaefm/"));
  assert.ok(!host.test("/opt/homebrew/bin/node /Users/owner/dev/other-server.mjs"));
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertBrowserPath, checkNodeRuntime, guardModeOf, loadConfig, parseConfigText, rootFromAppDir, rootPaths, validateConfig,
} from "../lib/config.mjs";
import { MAC_EDGE_CONFIG, WINDOWS_CONFIG, macChromeConfig, removeRoot, tempRoot } from "./helpers.mjs";

const BOM = String.fromCharCode(0xfeff);

test("collector.json: 앞의 BOM 을 지우고 읽는다(PS 5.1 이 BOM 을 붙여도 됨)", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "collector.json"), `${BOM}${JSON.stringify(WINDOWS_CONFIG)}`, "utf8");
    const config = loadConfig(root);
    assert.equal(config.platform, "windows");
    assert.equal(config.browser.kind, "edge");
    assert.equal(config.chromeGuard, null);
  } finally {
    removeRoot(root);
  }
});

test("collector.json 이 없거나 JSON 이 아니면 config_invalid", () => {
  const root = tempRoot();
  try {
    assert.throws(() => loadConfig(root), (error) => error.code === "config_invalid" && error.field === "missing");
    fs.writeFileSync(path.join(root, "collector.json"), "{nope", "utf8");
    assert.throws(() => loadConfig(root), (error) => error.code === "config_invalid" && error.field === "json");
  } finally {
    removeRoot(root);
  }
});

test("apiBase 는 운영 도메인 고정(다른 도메인 거절)", () => {
  for (const apiBase of ["https://evil.example.com", "http://insight.momentlabs.co.kr", "https://insight.momentlabs.co.kr/", "https://insight.momentlabs.co.kr.evil.com"]) {
    assert.throws(() => validateConfig({ ...WINDOWS_CONFIG, apiBase }), (error) => error.field === "apiBase");
  }
});

test("윈도우는 Edge 만: chrome 종류는 거절", () => {
  assert.throws(
    () => validateConfig({ ...WINDOWS_CONFIG, browser: { kind: "chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome-test.exe" } }),
    (error) => error.code === "config_invalid" && error.field === "browser.kind_windows_edge_only",
  );
});

test("브라우저 경로 규칙: 정식 Edge·Chrome 만, Beta·Dev·Canary 거절", () => {
  assert.doesNotThrow(() => assertBrowserPath("windows", "edge", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"));
  assert.doesNotThrow(() => assertBrowserPath("windows", "edge", "C:\\Users\\홍길동\\AppData\\Local\\Microsoft\\Edge\\Application\\MSEDGE.EXE"));
  assert.throws(() => assertBrowserPath("windows", "edge", "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe"));
  assert.throws(() => assertBrowserPath("windows", "edge", "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe"));
  assert.throws(() => assertBrowserPath("windows", "edge", "C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge SxS\\Application\\msedge.exe"));
  assert.throws(() => assertBrowserPath("windows", "edge", "C:\\Tools\\msedge.exe"));
  assert.doesNotThrow(() => assertBrowserPath("macos", "edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"));
  assert.throws(() => assertBrowserPath("macos", "edge", "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta"));
  assert.doesNotThrow(() => assertBrowserPath("macos", "chrome", "/Users/a/Desktop/Google Chrome.app/Contents/MacOS/Google Chrome"));
  assert.throws(() => assertBrowserPath("macos", "chrome", "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"));
  assert.throws(() => assertBrowserPath("macos", "chrome", "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"));
});

test("맥 chrome 이면 chromeGuard 가 반드시 있어야 하고, 값 모양을 검사한다", () => {
  const config = validateConfig(macChromeConfig());
  assert.equal(config.chromeGuard.intervalSeconds, 600);
  assert.equal(guardModeOf(config), "n30-chrome");
  assert.throws(() => validateConfig(macChromeConfig({ chromeGuard: null })), (error) => error.field === "chromeGuard");
  const base = macChromeConfig();
  assert.throws(() => validateConfig({ ...base, chromeGuard: { ...base.chromeGuard, schedulerLog: "relative.log" } }), (error) => error.field === "chromeGuard.schedulerLog");
  assert.throws(() => validateConfig({ ...base, chromeGuard: { ...base.chromeGuard, calendarLocalTimes: ["8:50"] } }), (error) => error.field === "chromeGuard.calendarLocalTimes");
  assert.throws(() => validateConfig({ ...base, chromeGuard: { ...base.chromeGuard, watchdogBusySeconds: 0 } }), (error) => error.field === "chromeGuard.watchdogBusySeconds");
});

test("Edge 면 보호 모드 none(맥·윈도우), chromeGuard 값이 있어도 쓰지 않는다", () => {
  assert.equal(guardModeOf(validateConfig(WINDOWS_CONFIG)), "none");
  const macEdge = validateConfig({ ...MAC_EDGE_CONFIG, chromeGuard: macChromeConfig().chromeGuard });
  assert.equal(macEdge.chromeGuard, null);
  assert.equal(guardModeOf(macEdge), "none");
});

test("schema·platform·nodePath 검사와 parseConfigText", () => {
  assert.throws(() => validateConfig({ ...WINDOWS_CONFIG, schema: 2 }), (error) => error.field === "schema");
  assert.throws(() => validateConfig({ ...WINDOWS_CONFIG, platform: "linux" }), (error) => error.field === "platform");
  assert.throws(() => validateConfig({ ...WINDOWS_CONFIG, nodePath: 5 }), (error) => error.field === "nodePath");
  assert.equal(parseConfigText(`${BOM}${JSON.stringify(MAC_EDGE_CONFIG)}`).platform, "macos");
});

test("루트는 app 폴더의 부모, 하위 이름은 §3.1", () => {
  const root = path.resolve("/tmp/x/CoupangRank");
  assert.equal(rootFromAppDir(path.join(root, "app")), root);
  const paths = rootPaths(root);
  assert.equal(paths.browserPid, path.join(root, "state", "browser.pid"));
  assert.equal(paths.lock, path.join(root, "state", "worker.lock"));
  assert.equal(paths.log, path.join(root, "logs", "worker.log"));
  assert.equal(paths.trialResults, path.join(root, "trial-results"));
});

test("실행 환경: Node 22~24 + WebSocket + toWellFormed", () => {
  assert.equal(checkNodeRuntime({ version: "22.12.0", webSocket: class {}, toWellFormed: () => "" }), true);
  assert.equal(checkNodeRuntime({ version: "24.16.0", webSocket: class {}, toWellFormed: () => "" }), true);
  assert.equal(checkNodeRuntime({ version: "20.18.0", webSocket: class {}, toWellFormed: () => "" }), false);
  assert.equal(checkNodeRuntime({ version: "25.0.0", webSocket: class {}, toWellFormed: () => "" }), false);
  assert.equal(checkNodeRuntime({ version: "22.12.0", webSocket: null, toWellFormed: () => "" }), false);
  assert.equal(checkNodeRuntime({ version: "22.12.0", webSocket: class {}, toWellFormed: null }), false);
  assert.equal(checkNodeRuntime(), true);
});

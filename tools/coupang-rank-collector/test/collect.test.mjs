import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { coupangSearchUrl } from "../lib/contract.mjs";
import { CdpConnection } from "../lib/cdp.mjs";
import { collectKeyword, emptyPage, splitAddress, windowBounds } from "../lib/collect.mjs";
import { nullLogger } from "../lib/log.mjs";
import { WINDOWS_CONFIG, fakeBrowser, fakeChild, fixture, removeRoot, tempRoot, withItems } from "./helpers.mjs";

const KEYWORD = "아이폰 18프로 사생활 보호 필름";

function harness({ browser, commandTimeoutMs = 2000, extraDeps = {} } = {}) {
  const closed = [];
  const launched = [];
  const deps = {
    launchBrowser: ({ profileDir, windowMode }) => {
      const child = fakeChild();
      launched.push({ profileDir, windowMode, child });
      return child;
    },
    readDevToolsActivePort: async () => "ws://127.0.0.1:50000/devtools/browser/abc",
    connect: (url) => CdpConnection.connect(url, { WebSocketImpl: browser.WebSocketImpl, commandTimeoutMs }),
    closeBrowser: async (args) => {
      closed.push(args);
      try { args.conn?.close(); } catch { /* 무시 */ }
      fs.rmSync(args.profileDir, { recursive: true, force: true });
      return { killed: false, cleanupFailed: false };
    },
    sleep: async () => {},
    jitter: (min) => min,
    navTimeoutMs: 200,
    hardCapMs: 5000,
    ...extraDeps,
  };
  return { deps, closed, launched };
}

function methods(browser) {
  return browser.calls.map((call) => call.method);
}

test("정상 쪽: 순서(타깃 만들기→붙기→창→Page/Network→이동→스크롤 8→읽기 A·B), ok, 증거 칸 채움, finally 정리", async () => {
  const root = tempRoot();
  try {
    const full = fixture("page-full.json");
    const browser = fakeBrowser({ extracts: [full, full], httpStatus: 200 });
    const { deps, closed, launched } = harness({ browser });
    const result = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps });
    assert.equal(result.page.status, "ok");
    assert.equal(result.page.httpStatus, 200);
    assert.equal(result.page.stable, true);
    assert.equal(result.page.itemCount, 60);
    assert.equal(result.page.organic.length, 50);
    assert.equal(result.page.ads.length, 10);
    assert.equal(result.page.finalHost, "www.coupang.com");
    assert.equal(result.page.finalPath, "/np/search");
    assert.equal(result.page.loginWall, true);
    assert.equal(result.page.errorCode, null);
    assert.equal(result.browser, "edge 141.0.3537.71");
    assert.equal(result.browserVersion, "141.0.3537.71");
    assert.deepEqual(Object.keys(result.page).sort(), Object.keys(emptyPage()).sort());
    assert.equal(launched[0].windowMode, "offscreen");
    assert.equal(closed.length, 1);
    assert.equal(closed[0].profileDir, launched[0].profileDir);
    assert.equal(fs.existsSync(launched[0].profileDir), false);
    const sequence = methods(browser);
    assert.deepEqual(sequence.slice(0, 8), [
      "Browser.getVersion", "Target.createTarget", "Target.attachToTarget", "Browser.getWindowForTarget", "Browser.setWindowBounds",
      "Page.enable", "Network.enable", "Page.navigate",
    ]);
    const evaluates = browser.calls.filter((call) => call.method === "Runtime.evaluate");
    assert.equal(evaluates.filter((call) => call.params.expression.includes("scrollBy")).length, 8);
    assert.equal(evaluates.filter((call) => !call.params.expression.includes("scrollBy")).length, 2);
    const navigate = browser.calls.find((call) => call.method === "Page.navigate");
    assert.equal(navigate.params.url, coupangSearchUrl(KEYWORD));
    assert.equal(navigate.sessionId, "S1");
    const bounds = browser.calls.find((call) => call.method === "Browser.setWindowBounds");
    assert.deepEqual(bounds.params, { windowId: 7, bounds: { left: -2400, top: -2400 } });
    assert.ok(!sequence.some((method) => /Input\.|DOM\.|click/i.test(method)), "상품을 클릭하지 않는다");
  } finally {
    removeRoot(root);
  }
});

test("A·B 개수가 다르면 2번 더 스크롤하고 C 와 B 를 비교한다(stable)", async () => {
  const root = tempRoot();
  try {
    const full = fixture("page-full.json");
    const unstable = fakeBrowser({ extracts: [withItems(full, 40), withItems(full, 55), full] });
    const first = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "normal", root, log: nullLogger(), deps: harness({ browser: unstable }).deps });
    assert.equal(first.page.stable, false);
    assert.equal(first.page.itemCount, 60);
    assert.equal(unstable.calls.filter((call) => call.method === "Runtime.evaluate" && call.params.expression.includes("scrollBy")).length, 10);
    const settles = fakeBrowser({ extracts: [withItems(full, 40), full, full] });
    const second = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "normal", root, log: nullLogger(), deps: harness({ browser: settles }).deps });
    assert.equal(second.page.stable, true);
    assert.equal(second.page.status, "ok");
    const bounds = settles.calls.find((call) => call.method === "Browser.setWindowBounds");
    assert.deepEqual(bounds.params.bounds, { left: 0, top: 0, width: 1280, height: 900 });
  } finally {
    removeRoot(root);
  }
});

test("차단: 403 이거나 차단 문구면 blocked(읽기 성공이어도)", async () => {
  const root = tempRoot();
  try {
    const full = fixture("page-full.json");
    const forbidden = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "minimized", root, log: nullLogger(), deps: harness({ browser: fakeBrowser({ extracts: [full, full], httpStatus: 403 }) }).deps });
    assert.equal(forbidden.page.status, "blocked");
    assert.equal(forbidden.page.httpStatus, 403);
    const text = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "normal", root, log: nullLogger(), deps: harness({ browser: fakeBrowser({ extracts: [{ ...full, items: [], blockedText: true }], httpStatus: 200 }) }).deps });
    assert.equal(text.page.status, "blocked");
    assert.equal(text.page.blockedText, true);
  } finally {
    removeRoot(root);
  }
});

test("읽기 시간 초과여도 httpStatus·finalHost·finalPath 를 채운다(Network.responseReceived 403, P2)", async () => {
  const root = tempRoot();
  try {
    const browser = fakeBrowser({ httpStatus: 403, documentUrl: "https://www.coupang.com/np/search?q=abc", hangEvaluate: true });
    const { deps, closed } = harness({ browser, commandTimeoutMs: 80 });
    const result = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps });
    assert.equal(result.page.status, "error");
    assert.equal(result.page.errorCode, "cdp_error");
    assert.equal(result.page.httpStatus, 403);
    assert.equal(result.page.finalHost, "www.coupang.com");
    assert.equal(result.page.finalPath, "/np/search");
    assert.equal(result.page.organic.length, 0);
    assert.equal(closed.length, 1);
  } finally {
    removeRoot(root);
  }
});

test("load 사건이 45초(여기선 짧게) 안에 없으면 timeout/page_timeout, 증거 칸은 채운다", async () => {
  const root = tempRoot();
  try {
    const browser = fakeBrowser({ httpStatus: 429, documentUrl: "https://login.coupang.com/login/login.pang?rtnUrl=x", loadEvent: false });
    const result = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps: harness({ browser }).deps });
    assert.equal(result.page.status, "timeout");
    assert.equal(result.page.errorCode, "page_timeout");
    assert.equal(result.page.httpStatus, 429);
    assert.equal(result.page.finalHost, "login.coupang.com");
    assert.equal(result.page.finalPath, "/login/login.pang");
  } finally {
    removeRoot(root);
  }
});

test("Document 응답이 없으면 Page.getNavigationHistory 로 주소를 한 번 찾는다", async () => {
  const root = tempRoot();
  try {
    const browser = fakeBrowser({ httpStatus: null, loadEvent: false, historyUrl: "https://www.coupang.com/np/search?q=zz" });
    const result = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps: harness({ browser }).deps });
    assert.equal(result.page.status, "timeout");
    assert.equal(result.page.httpStatus, null);
    assert.equal(result.page.finalHost, "www.coupang.com");
    assert.ok(methods(browser).includes("Page.getNavigationHistory"));
  } finally {
    removeRoot(root);
  }
});

test("이동 오류(errorText)·브라우저 실행 실패·포트 시간 초과·연결 실패는 error 와 알려진 코드", async () => {
  const root = tempRoot();
  try {
    const nav = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps: harness({ browser: fakeBrowser({ navigateErrorText: "net::ERR_HTTP2_PROTOCOL_ERROR", historyUrl: "https://www.coupang.com/np/search?q=1" }) }).deps });
    assert.equal(nav.page.status, "error");
    assert.equal(nav.page.errorCode, "cdp_error");
    assert.equal(nav.page.finalHost, "www.coupang.com");

    const launch = harness({ browser: fakeBrowser() });
    launch.deps.launchBrowser = () => { const error = new Error("ENOENT"); error.code = "browser_launch_failed"; throw error; };
    const launchFailed = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps: launch.deps });
    assert.equal(launchFailed.page.errorCode, "browser_launch_failed");
    assert.equal(launch.closed.length, 1, "실패해도 finally 에서 정리");

    const port = harness({ browser: fakeBrowser() });
    port.deps.readDevToolsActivePort = async () => { const error = new Error("x"); error.code = "devtools_port_timeout"; throw error; };
    assert.equal((await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps: port.deps })).page.errorCode, "devtools_port_timeout");

    const connect = harness({ browser: fakeBrowser() });
    connect.deps.connect = async () => { throw new Error("refused"); };
    assert.equal((await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps: connect.deps })).page.errorCode, "cdp_unreachable");

    const extract = harness({ browser: fakeBrowser({ extracts: ["not json"] }) });
    assert.equal((await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps: extract.deps })).page.errorCode, "extract_failed");
  } finally {
    removeRoot(root);
  }
});

test("창 위치를 못 바꿔도 측정은 계속한다", async () => {
  const root = tempRoot();
  try {
    const full = fixture("page-full.json");
    const result = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "minimized", root, log: nullLogger(), deps: harness({ browser: fakeBrowser({ extracts: [full, full], failWindow: true }) }).deps });
    assert.equal(result.page.status, "ok");
    assert.deepEqual(windowBounds("minimized"), { windowState: "minimized" });
  } finally {
    removeRoot(root);
  }
});

test("전체 120초 상한(browser_hard_cap)과 종료 신호(shutdown)는 error 로 끝내고 finally 에서 정리", async () => {
  const root = tempRoot();
  try {
    const capped = harness({ browser: fakeBrowser({ hangEvaluate: true }), commandTimeoutMs: 5000, extraDeps: { hardCapMs: 60 } });
    const cap = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), deps: capped.deps });
    assert.equal(cap.page.status, "error");
    assert.equal(cap.page.errorCode, "browser_hard_cap");
    assert.equal(capped.closed.length, 1);

    const controller = new AbortController();
    const stopping = harness({ browser: fakeBrowser({ hangEvaluate: true }), commandTimeoutMs: 5000 });
    setTimeout(() => controller.abort(), 30);
    const shutdown = await collectKeyword({ config: WINDOWS_CONFIG, keyword: KEYWORD, windowMode: "offscreen", root, log: nullLogger(), signal: controller.signal, deps: stopping.deps });
    assert.equal(shutdown.page.errorCode, "shutdown");
    assert.equal(stopping.closed.length, 1);
  } finally {
    removeRoot(root);
  }
});

test("splitAddress: 호스트 소문자 60자·경로 80자·쿼리 없음, http(s) 만", () => {
  assert.deepEqual(splitAddress("https://WWW.Coupang.com/np/search?q=a"), { host: "www.coupang.com", path: "/np/search" });
  assert.deepEqual(splitAddress("chrome-error://chromewebdata/"), { host: "", path: "" });
  assert.deepEqual(splitAddress(""), { host: "", path: "" });
  assert.equal(splitAddress(`https://www.coupang.com/${"a".repeat(200)}`).path.length, 80);
});

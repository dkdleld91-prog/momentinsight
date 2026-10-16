// 테스트 공용: 임시 루트, 가짜 시계, 가짜 브라우저(CDP 소켓), 가짜 자식 프로세스. 실제 브라우저·셸·네트워크를 쓰지 않는다.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const COLLECTOR_DIR = path.resolve(TEST_DIR, "..");

export function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(TEST_DIR, "fixtures", name), "utf8"));
}

export function tempRoot(prefix = "mi-coupang-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const name of ["app", "runs", "outbox", "state", "logs", "trial-results"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  return root;
}

export function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

export function fakeClock(start = Date.parse("2026-10-17T02:00:00.000Z")) {
  let current = start;
  const sleeps = [];
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    sleeps,
    sleep: async (ms) => { sleeps.push(ms); current += Math.max(0, ms); },
  };
}

export function fakeChild({ pid = 43210, exitsOnClose = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.exitsOnClose = exitsOnClose;
  child.exit = (code = 0) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.emit("exit", code, null);
  };
  return child;
}

export const WINDOWS_CONFIG = Object.freeze({
  schema: 1,
  platform: "windows",
  apiBase: "https://insight.momentlabs.co.kr",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  browser: Object.freeze({ kind: "edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" }),
  chromeGuard: null,
});

export const MAC_EDGE_CONFIG = Object.freeze({
  schema: 1,
  platform: "macos",
  apiBase: "https://insight.momentlabs.co.kr",
  nodePath: "/opt/homebrew/bin/node",
  browser: Object.freeze({ kind: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }),
  chromeGuard: null,
});

export function macChromeConfig(overrides = {}) {
  return {
    schema: 1,
    platform: "macos",
    apiBase: "https://insight.momentlabs.co.kr",
    nodePath: "/opt/homebrew/bin/node",
    browser: { kind: "chrome", path: "/Users/tester/Desktop/Google Chrome.app/Contents/MacOS/Google Chrome" },
    chromeGuard: {
      schedulerLog: "/Users/tester/Library/Logs/MomentInsight/scheduler-test.log",
      watchdogLog: "/Users/tester/Library/Logs/MomentInsight/watchdog-test.log",
      intervalSeconds: 600,
      calendarLocalTimes: ["08:50", "14:50"],
      marginSeconds: 60,
      driftSeconds: 30,
      watchdogBusySeconds: 420,
    },
    ...overrides,
  };
}

// 가짜 브라우저 소켓. Page.navigate 에 Document 응답(상태·주소)과 load 사건을 보내고, 읽기 함수에는 고정본을 준다.
export function fakeBrowser({
  extracts = [],
  httpStatus = 200,
  documentUrl = "https://www.coupang.com/np/search?q=x",
  documentFrameId = "T1",
  loadEvent = true,
  navigateErrorText = null,
  hangEvaluate = false,
  historyUrl = "",
  product = "Edg/141.0.3537.71",
  userAgent = "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.71",
  failWindow = false,
} = {}) {
  const calls = [];
  const sockets = [];
  const queue = [...extracts];
  let lastExtract = queue.length ? queue[queue.length - 1] : null;
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      sockets.push(this);
      setImmediate(() => this.emit("open", {}));
    }
    addEventListener(type, fn, options) {
      const list = this.listeners.get(type) || [];
      list.push({ fn, once: Boolean(options?.once) });
      this.listeners.set(type, list);
    }
    emit(type, event) {
      const list = this.listeners.get(type) || [];
      this.listeners.set(type, list.filter((item) => !item.once));
      for (const item of list) item.fn(event);
    }
    message(payload) {
      if (this.closed) return;
      this.emit("message", { data: JSON.stringify(payload) });
    }
    send(data) {
      const message = JSON.parse(data);
      calls.push(message);
      setImmediate(() => this.handle(message));
    }
    reply(message, result) {
      const payload = { id: message.id, result };
      if (message.sessionId) payload.sessionId = message.sessionId;
      this.message(payload);
    }
    handle(message) {
      const { method, params = {} } = message;
      switch (method) {
        case "Browser.getVersion":
          return this.reply(message, { product, userAgent });
        case "Target.createTarget":
          return this.reply(message, { targetId: "T1" });
        case "Target.attachToTarget":
          return this.reply(message, { sessionId: "S1" });
        case "Browser.getWindowForTarget":
          if (failWindow) return this.message({ id: message.id, error: { message: "no window" } });
          return this.reply(message, { windowId: 7, bounds: {} });
        case "Page.navigate":
          this.reply(message, navigateErrorText ? { frameId: "T1", errorText: navigateErrorText } : { frameId: "T1", loaderId: "L1" });
          if (navigateErrorText) return undefined;
          setImmediate(() => {
            if (httpStatus !== null) {
              this.message({ method: "Network.responseReceived", sessionId: "S1", params: { type: "Image", frameId: "T1", response: { status: 500, url: "https://image.coupangcdn.com/x.png" } } });
              this.message({ method: "Network.responseReceived", sessionId: "S1", params: { type: "Document", frameId: "OTHER", response: { status: 404, url: "https://ads.example.com/frame" } } });
              this.message({ method: "Network.responseReceived", sessionId: "S1", params: { type: "Document", frameId: documentFrameId, response: { status: httpStatus, url: documentUrl } } });
            }
            if (loadEvent) this.message({ method: "Page.loadEventFired", sessionId: "S1", params: { timestamp: 1 } });
          });
          return undefined;
        case "Runtime.evaluate": {
          if (String(params.expression).includes("scrollBy")) return this.reply(message, { result: { type: "undefined" } });
          if (hangEvaluate) return undefined;
          const next = queue.length ? queue.shift() : lastExtract;
          lastExtract = next;
          return this.reply(message, { result: { type: "string", value: typeof next === "string" ? next : JSON.stringify(next) } });
        }
        case "Page.getNavigationHistory":
          return this.reply(message, { currentIndex: 0, entries: [{ id: 1, url: historyUrl, title: "" }] });
        default:
          return this.reply(message, {});
      }
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close", {});
    }
  }
  return { WebSocketImpl: FakeSocket, calls, sockets };
}

export function withItems(base, count) {
  return { ...base, items: base.items.slice(0, count) };
}

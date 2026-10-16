// 키워드 1개 측정(명세 §9.2 lib/collect.mjs). 실패해도 결과 객체를 돌려주고, finally 에서 브라우저·프로필을 정리한다.
// 맥 시험 수집기(검증본)의 흐름을 따른다: 새 프로필 → CDP → 검색 1쪽 → 2.5초 → 스크롤 8번 → 읽기. 상품은 클릭하지 않는다.
// 바뀐 점: 고정 포트 대신 DevToolsActivePort, 브라우저 소켓 + flatten 세션, 실패해도 httpStatus·최종 주소를 채움(P2).
import {
  BLOCKED_HTTP_STATUSES, BROWSER_HARD_CAP_SECONDS, COLLECTOR_ERROR_CODES, DEFAULT_WINDOW_MODE, NAV_TIMEOUT_MS, WINDOW_MODES,
  coupangSearchUrl,
} from "./contract.mjs";
import {
  browserVersion as defaultBrowserVersion, closeBrowser as defaultCloseBrowser, launchBrowser as defaultLaunchBrowser,
  makeProfileDir as defaultMakeProfileDir, readDevToolsActivePort as defaultReadDevToolsActivePort,
} from "./browser.mjs";
import { CdpConnection } from "./cdp.mjs";
import { EXTRACT_SOURCE, ExtractError, parseExtractResult, splitItems } from "./extract.mjs";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultJitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

export const SETTLE_MS = 2500;
export const SCROLL_COUNT = 8;
export const EXTRA_SCROLL_COUNT = 2;
export const SCROLL_PIXELS = 1400;
export const SCROLL_GAP_MS = Object.freeze([350, 700]);
export const READ_GAP_MS = 1200;
export const HISTORY_TIMEOUT_MS = 5000;

class CollectFailure extends Error {
  constructor(status, code) {
    super(code);
    this.pageStatus = status;
    this.code = code;
  }
}

export function emptyPage() {
  return {
    status: "error",
    httpStatus: null,
    loginWall: false,
    stable: false,
    noResultText: false,
    blockedText: false,
    itemCount: 0,
    organic: [],
    ads: [],
    finalHost: "",
    finalPath: "",
    errorCode: null,
  };
}

export function splitAddress(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!/^https?:$/.test(parsed.protocol)) return { host: "", path: "" };
    return { host: parsed.host.toLowerCase().slice(0, 60), path: parsed.pathname.slice(0, 80) };
  } catch {
    return { host: "", path: "" };
  }
}

function normalizeErrorCode(error) {
  const code = error?.code;
  if (code === "profile_dir_unsafe") return "browser_launch_failed";
  return COLLECTOR_ERROR_CODES.includes(code) ? code : "cdp_error";
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]);
}

export function windowBounds(windowMode) {
  if (windowMode === "minimized") return { windowState: "minimized" };
  if (windowMode === "offscreen") return { left: -2400, top: -2400 };
  return { left: 0, top: 0, width: 1280, height: 900 };
}

export async function collectKeyword({ config, keyword, windowMode, root, log, signal, onLaunched, deps = {} }) {
  const d = {
    makeProfileDir: defaultMakeProfileDir,
    launchBrowser: defaultLaunchBrowser,
    readDevToolsActivePort: defaultReadDevToolsActivePort,
    connect: (wsUrl) => CdpConnection.connect(wsUrl),
    closeBrowser: defaultCloseBrowser,
    browserVersion: defaultBrowserVersion,
    sleep: defaultSleep,
    jitter: defaultJitter,
    now: Date.now,
    hardCapMs: BROWSER_HARD_CAP_SECONDS * 1000,
    navTimeoutMs: NAV_TIMEOUT_MS,
    ...deps,
  };
  const mode = WINDOW_MODES.includes(windowMode) ? windowMode : DEFAULT_WINDOW_MODE;
  const kind = config?.browser?.kind || "edge";
  const startedAt = d.now();
  const page = emptyPage();
  const state = { child: null, conn: null, sessionId: null, targetId: null, profileDir: null, version: "unknown", docStatus: null, docUrl: "" };

  const inner = new AbortController();
  const stop = (code) => {
    if (!inner.signal.aborted) inner.abort(new CollectFailure("error", code));
  };
  const abortPromise = new Promise((_, reject) => {
    inner.signal.addEventListener("abort", () => reject(inner.signal.reason), { once: true });
  });
  abortPromise.catch(() => {});
  const hardTimer = setTimeout(() => stop("browser_hard_cap"), d.hardCapMs);
  const onOuterAbort = () => stop("shutdown");
  if (signal) {
    if (signal.aborted) stop("shutdown");
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const guarded = (promise) => Promise.race([promise, abortPromise]);
  const pause = (ms) => guarded(d.sleep(ms));

  async function evaluate(expression) {
    const result = await guarded(state.conn.send("Runtime.evaluate", { expression, returnByValue: true }, state.sessionId));
    if (result?.exceptionDetails) throw new ExtractError("evaluate_exception");
    return result?.result?.value;
  }

  async function read() {
    const value = await evaluate(EXTRACT_SOURCE);
    return parseExtractResult(value);
  }

  async function scroll(times) {
    for (let index = 0; index < times; index += 1) {
      await guarded(state.conn.send("Runtime.evaluate", { expression: `window.scrollBy(0, ${SCROLL_PIXELS})`, returnByValue: true }, state.sessionId));
      await pause(d.jitter(SCROLL_GAP_MS[0], SCROLL_GAP_MS[1]));
    }
  }

  async function run() {
    state.profileDir = d.makeProfileDir(root);
    state.child = d.launchBrowser({ config, profileDir: state.profileDir, root, windowMode: mode });
    if (typeof onLaunched === "function") {
      try { await onLaunched(state.child); } catch { /* 관찰용 처리기 오류는 측정을 막지 않는다 */ }
    }
    const wsUrl = await guarded(d.readDevToolsActivePort(state.profileDir, 20000, { child: state.child }));
    try {
      state.conn = await guarded(d.connect(wsUrl));
    } catch (error) {
      if (inner.signal.aborted) throw error;
      throw new CollectFailure("error", "cdp_unreachable");
    }
    state.version = await guarded(d.browserVersion(state.conn, kind));
    const created = await guarded(state.conn.send("Target.createTarget", { url: "about:blank" }));
    state.targetId = created?.targetId;
    const attached = await guarded(state.conn.send("Target.attachToTarget", { targetId: state.targetId, flatten: true }));
    state.sessionId = attached?.sessionId;
    if (!state.targetId || !state.sessionId) throw new CollectFailure("error", "cdp_error");
    try {
      const found = await guarded(state.conn.send("Browser.getWindowForTarget", { targetId: state.targetId }));
      if (found?.windowId !== undefined) {
        await guarded(state.conn.send("Browser.setWindowBounds", { windowId: found.windowId, bounds: windowBounds(mode) }));
      }
    } catch (error) {
      if (inner.signal.aborted) throw error;
      // 창 위치를 못 바꿔도 측정은 계속한다.
    }
    // 브라우저 프로세스가 보내는 주 프레임 Document 응답: 쪽 스크립트가 멈춰도 상태·주소가 남는다.
    state.conn.on("Network.responseReceived", (params) => {
      if (params?.type !== "Document") return;
      if (params.frameId && params.frameId !== state.targetId) return;
      const status = Number(params.response?.status);
      state.docStatus = Number.isInteger(status) && status >= 0 && status <= 599 ? status : null;
      state.docUrl = String(params.response?.url || "");
    }, state.sessionId);
    await guarded(state.conn.send("Page.enable", {}, state.sessionId));
    await guarded(state.conn.send("Network.enable", {}, state.sessionId));
    const loaded = state.conn.waitFor("Page.loadEventFired", d.navTimeoutMs, state.sessionId);
    const navigation = await guarded(state.conn.send("Page.navigate", { url: coupangSearchUrl(keyword) }, state.sessionId));
    if (navigation?.errorText) throw new CollectFailure("error", "cdp_error");
    const loadEvent = await guarded(loaded);
    if (!loadEvent) throw new CollectFailure("timeout", "page_timeout");
    await pause(SETTLE_MS);
    await scroll(SCROLL_COUNT);
    await pause(READ_GAP_MS);
    const first = await read();
    await pause(READ_GAP_MS);
    const second = await read();
    let final = second;
    let stable = true;
    if (first.items.length !== second.items.length) {
      await scroll(EXTRA_SCROLL_COUNT);
      await pause(READ_GAP_MS);
      const third = await read();
      stable = third.items.length === second.items.length;
      final = third;
    }
    const split = splitItems(final);
    const address = final.host ? { host: final.host, path: final.path } : splitAddress(state.docUrl);
    page.httpStatus = state.docStatus;
    page.loginWall = final.loginWall;
    page.stable = stable;
    page.noResultText = final.noResultText;
    page.blockedText = final.blockedText;
    page.itemCount = split.itemCount;
    page.organic = split.organic;
    page.ads = split.ads;
    page.finalHost = address.host;
    page.finalPath = address.path;
    page.errorCode = null;
    page.status = page.blockedText || BLOCKED_HTTP_STATUSES.includes(page.httpStatus) ? "blocked" : "ok";
  }

  const runPromise = run();
  runPromise.catch(() => {});
  let cleanupFailed = false;
  try {
    await Promise.race([runPromise, abortPromise]);
  } catch (error) {
    page.status = error?.pageStatus === "timeout" ? "timeout" : "error";
    if (error instanceof CollectFailure) page.errorCode = error.code;
    else if (!state.child && !COLLECTOR_ERROR_CODES.includes(error?.code)) page.errorCode = "browser_launch_failed";
    else page.errorCode = normalizeErrorCode(error);
    page.stable = false;
  } finally {
    clearTimeout(hardTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
    if (page.status !== "ok" && page.status !== "blocked") {
      // 실패해도 채움(P2): "읽기 시간 초과 + 403" 이 서버에서 차단으로 판정되게.
      page.httpStatus = state.docStatus;
      let address = splitAddress(state.docUrl);
      if (!address.host && state.conn && state.sessionId && !state.conn.closed) {
        try {
          const history = await withTimeout(state.conn.send("Page.getNavigationHistory", {}, state.sessionId), HISTORY_TIMEOUT_MS);
          const entry = history?.entries?.[history?.currentIndex];
          address = splitAddress(entry?.url);
        } catch {
          // 주소를 끝내 모르면 빈값(서버가 error 로 판정).
        }
      }
      page.finalHost = address.host;
      page.finalPath = address.path;
    }
    try {
      const closed = await d.closeBrowser({
        child: state.child, conn: state.conn, platform: config?.platform, profileDir: state.profileDir, root, log,
      });
      cleanupFailed = Boolean(closed?.cleanupFailed);
    } catch {
      cleanupFailed = true;
    }
  }
  const durationMs = Math.max(0, Math.min(600000, d.now() - startedAt));
  return {
    page,
    durationMs,
    browser: `${kind} ${state.version || "unknown"}`.slice(0, 60),
    browserVersion: state.version || "unknown",
    cleanupFailed,
  };
}

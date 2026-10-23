// C 30일 ① '지금 확인' 확장 — 서비스 워커(spec-manual §4.4, 2026-10-23 구현).
// 관리자 화면(insight.momentlabs.co.kr/admin)이 보낸 메시지에만 답한다. 예약·알람·자동 반복은 없다.
// 확인 1번의 순서:
//   1) 작업 중 표시(바로) → 2) 확장 안 검사(오늘 본 차단·같은 크롬 상대 간격·시크릿 허용·사이트 액세스·다른 시크릿 창)
//   → 3) 서버 확인(GET manual-verify: 토큰·기한·상태·전역 간격을 서버 시각으로 판정, 이 요청을 '검색함'으로 한 번만 표시)
//   → 4) 빈 시크릿 창을 열어 정말 시크릿인지 보고 → 5) 그 탭만 서버가 준 검색어의 쿠팡 검색 1쪽으로 → 6) 읽기 → 7) 창 닫기(항상)
//   → 8) 차단 신호면 서버에 바로 '그날 중지'(GET manual-stop) → 9) 결과를 storage.local 에 남기고 화면에 답
//      (화면이 manual-record 로 서버에 보낸 뒤 ack 할 때까지. 탭이 닫혀도 다음 hello 가 다시 준다).
// 창을 연 뒤에는 상품을 누르지 않고 입력하지 않는다. 스크롤은 수집기와 같은 범위만 한다.
import {
  ACTIVE_STALE_MS, CLOSE_TIMEOUT_MS, COUPANG_ORIGIN_PATTERN, EXTENSION_REPORTED_STOP, EXTENSION_VERSION, EXTRA_SCROLL_COUNT,
  HARD_CAP_MS, KEEPALIVE_MS, LOAD_TIMEOUT_MS, LOCAL_MIN_GAP_MS, PROBE_INTERVAL_MS, QUICK_READ_TIMEOUT_MS, READ_GAP_MS,
  RESULT_RESEND_MS, SCROLL_COUNT, SCROLL_GAP_MS, SCROLL_PIXELS, SEARCH_HOST, SEARCH_PATH, SERVER_ORIGIN_PATTERN,
  SERVER_TIMEOUT_MS, SETTLE_MS, UNREADABLE_ERROR_CODE, WINDOW_HEIGHT, WINDOW_WIDTH,
  browserLabel, isAllowedSender, isUuid, kstDayOf, parseMessage, reportStop, searchUrl, splitAddress, verifyClaim,
} from "./lib/protocol.js";
import { miCoupangMeasure, miCoupangProbe } from "./lib/measure.js";
import { assemblePage, stopReasonOf } from "./lib/assemble.js";

export const DEFAULT_TIMING = Object.freeze({
  loadTimeoutMs: LOAD_TIMEOUT_MS,
  hardCapMs: HARD_CAP_MS,
  keepaliveMs: KEEPALIVE_MS,
  probeIntervalMs: PROBE_INTERVAL_MS,
  quickReadTimeoutMs: QUICK_READ_TIMEOUT_MS,
  closeTimeoutMs: CLOSE_TIMEOUT_MS,
  serverTimeoutMs: SERVER_TIMEOUT_MS,
  localMinGapMs: LOCAL_MIN_GAP_MS,
  activeStaleMs: ACTIVE_STALE_MS,
  resultResendMs: RESULT_RESEND_MS,
});
export const DEFAULT_MEASURE_OPTIONS = Object.freeze({
  settleMs: SETTLE_MS,
  scrollCount: SCROLL_COUNT,
  extraScrollCount: EXTRA_SCROLL_COUNT,
  scrollPixels: SCROLL_PIXELS,
  gapMin: SCROLL_GAP_MS[0],
  gapMax: SCROLL_GAP_MS[1],
  readGapMs: READ_GAP_MS,
});
// 다른 시크릿 창 찾기: 모든 창 종류를 본다(기본값은 normal·popup 만 본다).
export const ALL_WINDOW_TYPES = Object.freeze(["normal", "popup", "panel", "app", "devtools"]);
const DURATION_MAX_MS = 600000;

class StopError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function createBackground(chromeApi, deps = {}) {
  const c = chromeApi;
  const t = { ...DEFAULT_TIMING, ...(deps.timing || {}) };
  const measureOptions = { ...DEFAULT_MEASURE_OPTIONS, ...(deps.measure || {}) };
  const timers = deps.timers || {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  };
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const fetchImpl = typeof deps.fetch === "function" ? deps.fetch : (url, init) => globalThis.fetch(url, init);
  const browser = browserLabel(typeof deps.uaText === "string" ? deps.uaText : globalThis.navigator?.userAgent);
  const serverOptions = { version: EXTENSION_VERSION, timeoutMs: t.serverTimeoutMs, timers };
  const state = { busy: false, activeWindowId: null, leftover: { closed: 0, unknown: false }, ready: Promise.resolve() };

  // ── 저장소(실패해도 멈추지 않는다) ──
  async function load(keys) {
    try {
      const value = await c.storage.local.get(keys);
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }
  async function save(values) {
    try {
      await c.storage.local.set(values);
      return true;
    } catch {
      return false;
    }
  }
  async function drop(keys) {
    try {
      await c.storage.local.remove(keys);
    } catch {
      // 지우지 못해도 다음 실행 때 다시 본다.
    }
  }

  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      Promise.resolve(promise).finally(() => timers.clearTimeout(timer)),
      new Promise((_, reject) => { timer = timers.setTimeout(() => reject(new StopError("timeout")), ms); }),
    ]);
  }

  // ── 확장 안 검사 ──
  async function incognitoAllowed() {
    try {
      return (await c.extension.isAllowedIncognitoAccess()) === true;
    } catch {
      return false;
    }
  }
  // 사이트 액세스(세부정보)를 '클릭 시'로 바꾸면 필수 권한도 막힌다. 막혔거나 알 수 없으면 창을 열지 않는다.
  async function hostAccess() {
    if (!c.permissions || typeof c.permissions.contains !== "function") return null;
    try {
      return (await c.permissions.contains({ origins: [COUPANG_ORIGIN_PATTERN, SERVER_ORIGIN_PATTERN] })) === true;
    } catch {
      return null;
    }
  }
  // 다른 시크릿 창이 하나라도 있으면 같은 시크릿 세션(쿠키)이 이어지므로 멈춘다. 목록을 못 읽으면 '열림'으로 본다.
  async function incognitoWindowOpen(exceptWindowId) {
    let list = null;
    try {
      list = await c.windows.getAll({ windowTypes: [...ALL_WINDOW_TYPES] });
    } catch {
      list = null;
    }
    if (!Array.isArray(list)) {
      try {
        list = await c.windows.getAll();
      } catch {
        return true;
      }
    }
    if (!Array.isArray(list)) return true;
    return list.some((win) => win && win.incognito === true && win.id !== exceptWindowId);
  }
  // 날짜는 서버 시각으로만 센다: 마지막 서버 확인 때 잰 (서버 시각 − 맥 시계) 차이를 더한다.
  async function serverNowEstimate() {
    const { serverOffsetMs } = await load(["serverOffsetMs"]);
    return now() + (Number.isFinite(serverOffsetMs) ? serverOffsetMs : 0);
  }

  // ── 남은 창 정리(워커 시작·hello 때) ──
  async function cleanupLeftover() {
    const { active } = await load(["active"]);
    if (!active || typeof active !== "object") return;
    if (state.busy && active.windowId === state.activeWindowId) return;
    const windowId = Number.isInteger(active.windowId) ? active.windowId : null;
    let win = null;
    if (windowId !== null) {
      try {
        win = await c.windows.get(windowId);
      } catch {
        win = null;
      }
    }
    if (!win) {
      await drop("active");
      return;
    }
    const age = now() - Number(active.startedAt);
    const fresh = Number.isFinite(age) && age >= 0 && age <= t.activeStaleMs;
    if (fresh && win.incognito === true) {
      try {
        await c.windows.remove(windowId);
        state.leftover.closed += 1;
        await drop("active");
      } catch {
        state.leftover.unknown = true; // 기록은 남겨 다음 hello 때 다시 닫아 본다
      }
      return;
    }
    // 오래된 기록: 브라우저를 다시 켜 창 번호가 다시 쓰였을 수 있어 닫지 않는다. 화면이 '직접 닫기'를 안내한다.
    if (win.incognito === true) state.leftover.unknown = true;
    await drop("active");
  }

  // ── 보고 대기 결과(화면이 서버에 보내고 ack 할 때까지) ──
  async function currentPending() {
    const { pending } = await load(["pending"]);
    if (!pending || typeof pending !== "object" || !isUuid(pending.claimId)) return null;
    const today = kstDayOf(await serverNowEstimate());
    const age = now() - Number(pending.savedAt);
    const staleDay = Boolean(pending.serverDay && today && pending.serverDay !== today);
    // 차단 아닌 결과는 서버 늦은 보고 기한(10분)까지만, 차단 결과는 그날 안에서만 다시 준다.
    const staleResult = pending.stop !== true && Number.isFinite(age) && age > t.resultResendMs;
    if (staleDay || staleResult) {
      await drop("pending");
      return null;
    }
    return pending;
  }
  // 화면에 다시 줄 모양: { claimId, claimToken, stop, stopReason, stopReported, serverDay, ageMs, reply(= check 답 그대로) }
  function publicPending(pending) {
    const age = now() - Number(pending.savedAt);
    return {
      claimId: pending.claimId,
      claimToken: pending.claimToken,
      stop: pending.stop === true,
      stopReason: pending.stopReason || null,
      stopReported: pending.stopReported === true,
      serverDay: pending.serverDay || null,
      ageMs: Number.isFinite(age) && age >= 0 ? age : null,
      reply: pending.reply && typeof pending.reply === "object" ? pending.reply : null,
    };
  }

  async function sendStop(claimId, claimToken, reason, serverDay) {
    const result = await reportStop(fetchImpl, { claimId, claimToken, reason, ...serverOptions });
    if (result.ok && serverDay) await save({ stopReportedDay: serverDay });
    return result.ok === true;
  }

  function notStarted(code, claimId, extra = {}) {
    return { ok: false, outcome: "not_started", code, claimId: claimId || null, ...extra };
  }

  // ── hello ──
  async function hello() {
    await state.ready;
    await cleanupLeftover();
    const allowed = await incognitoAllowed();
    const access = await hostAccess();
    // 시크릿 허용이 꺼져 있으면 시크릿 창을 볼 수 없다(모름 = null).
    const open = allowed ? await incognitoWindowOpen(state.busy ? state.activeWindowId : null) : null;
    const pending = await currentPending();
    let installType = null;
    try {
      const self = c.management && typeof c.management.getSelf === "function" ? await c.management.getSelf() : null;
      installType = typeof self?.installType === "string" ? self.installType : null;
    } catch {
      installType = null;
    }
    const leftover = { ...state.leftover };
    state.leftover = { closed: 0, unknown: false };
    return {
      ok: true,
      type: "hello",
      version: EXTENSION_VERSION,
      incognitoAllowed: allowed,
      hostAccess: access,
      incognitoWindowOpen: open,
      busy: state.busy,
      browser,
      installType,
      pending: pending ? publicPending(pending) : null,
      leftover,
    };
  }

  // ── ack: 화면이 서버 기록을 마쳤다(받음·중복·끝난 요청 등 확정 답) ──
  async function ack({ claimId }) {
    const { pending } = await load(["pending"]);
    if (pending && typeof pending === "object" && pending.claimId === claimId) {
      await drop("pending");
      return { ok: true, type: "ack", cleared: true };
    }
    return { ok: true, type: "ack", cleared: false };
  }

  // ── check ──
  function check(request) {
    // 작업 중 표시는 await 전에 켠다: 같은 순간 두 요청이 와도 창은 1개만 열린다.
    if (state.busy) return Promise.resolve(notStarted("busy", request.claimId));
    state.busy = true;
    return runCheck(request)
      .catch(() => notStarted("extension_error", request.claimId))
      .finally(() => {
        state.busy = false;
        state.activeWindowId = null;
      });
  }

  async function runCheck({ claimId, claimToken }) {
    await state.ready;
    // 차단을 본 결과가 아직 화면→서버 기록(ack)을 거치지 않았으면 새 검색은 없다(report_pending + 그 결과).
    // 서버에 그날 중지를 아직 알리지 못했으면 지금 그 결과의 토큰으로 다시 알린다. 화면은 받은 결과를 manual-record 로 보낸다.
    const pending = await currentPending();
    if (pending && pending.stop === true) {
      if (pending.stopReported !== true && await sendStop(pending.claimId, pending.claimToken, pending.stopReason, pending.serverDay)) {
        pending.stopReported = true;
        await save({ pending });
      }
      return notStarted("report_pending", claimId, { stopReported: pending.stopReported === true, pending: publicPending(pending) });
    }
    // 그날 차단을 본 적이 있으면(결과는 이미 기록됨) 새 검색은 없다. 서버에 알린 기록이 없으면 이번 요청 토큰으로 알린다.
    const store = await load(["blockedDay", "stopReportedDay", "lastCheckAt"]);
    const today = kstDayOf(await serverNowEstimate());
    if (typeof store.blockedDay === "string" && store.blockedDay === today) {
      let reported = store.stopReportedDay === today;
      if (!reported) reported = await sendStop(claimId, claimToken, EXTENSION_REPORTED_STOP, today);
      return notStarted("blocked_today", claimId, { stopReported: reported });
    }
    const last = Number(store.lastCheckAt);
    const since = now() - last;
    if (Number.isFinite(last) && since >= 0 && since < t.localMinGapMs) {
      return notStarted("too_soon", claimId, { retryAfterSec: Math.ceil((t.localMinGapMs - since) / 1000) });
    }
    if (!(await incognitoAllowed())) return notStarted("incognito_not_allowed", claimId);
    const access = await hostAccess();
    if (access !== true) return notStarted("host_access_withheld", claimId, { hostAccess: access });
    if (await incognitoWindowOpen(null)) return notStarted("incognito_window_open", claimId);

    // 서버 확인: 실제 검색 직전. 간격·하루·시간·그날 중지·기한·1회용은 서버가 서버 시각으로 판정한다.
    const verified = await verifyClaim(fetchImpl, { claimId, claimToken, ...serverOptions });
    if (!verified.ok) {
      const { ok: _ok, code, ...detail } = verified;
      return notStarted(code, claimId, detail);
    }
    const verifiedAtLocal = now();
    if (Number.isFinite(verified.serverTimeMs)) await save({ serverOffsetMs: verified.serverTimeMs - verifiedAtLocal });
    const serverDay = kstDayOf(Number.isFinite(verified.serverTimeMs) ? verified.serverTimeMs : verifiedAtLocal);
    return openAndMeasure({ claimId, claimToken, keyword: verified.keyword, serverDay });
  }

  // 창 하나의 수명: 120초 상한, 사람이 닫음, 15초마다 깨우기, 측정 중 주소 바뀜 표시.
  function createRun(windowId) {
    let stopCode = null;
    let windowGone = false;
    let tabId = null;
    let measuring = false;
    let navigatedDuringMeasure = false;
    let navigationIssued = false;
    let rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    stopped.catch(() => {});
    const stop = (code) => {
      if (stopCode) return;
      stopCode = code;
      rejectStop(new StopError(code));
    };
    const hardTimer = timers.setTimeout(() => stop("browser_hard_cap"), t.hardCapMs);
    const keepalive = timers.setInterval(() => {
      Promise.resolve().then(() => c.windows.get(windowId)).catch(() => {});
    }, t.keepaliveMs);
    const onWindowRemoved = (id) => {
      if (id !== windowId) return;
      windowGone = true;
      stop("window_closed");
    };
    const onTabRemoved = (id) => {
      if (tabId !== null && id === tabId) stop("window_closed");
    };
    const onTabUpdated = (id, info) => {
      if (tabId === null || id !== tabId || !measuring || !info) return;
      if (info.status === "loading" || typeof info.url === "string") navigatedDuringMeasure = true;
    };
    c.windows.onRemoved.addListener(onWindowRemoved);
    c.tabs.onRemoved.addListener(onTabRemoved);
    c.tabs.onUpdated.addListener(onTabUpdated);
    return {
      get windowGone() { return windowGone; },
      get navigatedDuringMeasure() { return navigatedDuringMeasure; },
      get navigationIssued() { return navigationIssued; },
      markNavigationIssued() { navigationIssued = true; },
      watchTab(id) { tabId = id; },
      setMeasuring(value) { measuring = value; },
      guard(promise) { return Promise.race([promise, stopped]); },
      dispose() {
        timers.clearTimeout(hardTimer);
        timers.clearInterval(keepalive);
        c.windows.onRemoved.removeListener(onWindowRemoved);
        c.tabs.onRemoved.removeListener(onTabRemoved);
        c.tabs.onUpdated.removeListener(onTabUpdated);
      },
    };
  }

  // 주 문서 load 기다리기: 탭 status 'complete'(이동 시작을 본 뒤) 또는 쪽 안 readyState 'complete' 중 먼저 오는 것.
  function startLoadWatch(run, tabId) {
    let navStarted = false;
    let settled = false;
    let probing = false;
    let resolveWait;
    const done = new Promise((resolve) => { resolveWait = resolve; });
    const onUpdated = (id, info) => {
      if (id !== tabId || !info) return;
      if (info.status === "loading" || typeof info.url === "string") navStarted = true;
      if (info.status === "complete" && navStarted) finish("complete");
    };
    const timeout = timers.setTimeout(() => finish("timeout"), t.loadTimeoutMs);
    const probe = timers.setInterval(() => {
      if (probing || settled) return;
      probing = true;
      Promise.resolve()
        .then(() => c.scripting.executeScript({ target: { tabId }, func: miCoupangProbe, injectImmediately: true }))
        .then((results) => {
          const r = Array.isArray(results) ? results[0]?.result : null;
          if (r && r.readyState === "complete" && r.host === SEARCH_HOST) finish("probe");
        })
        .catch(() => {})
        .finally(() => { probing = false; });
    }, t.probeIntervalMs);
    function finish(how) {
      if (settled) return;
      settled = true;
      c.tabs.onUpdated.removeListener(onUpdated);
      timers.clearTimeout(timeout);
      timers.clearInterval(probe);
      resolveWait(how);
    }
    c.tabs.onUpdated.addListener(onUpdated);
    return {
      markStarted() { navStarted = true; },
      wait() { return run.guard(done); },
      cancel() { finish("cancelled"); },
    };
  }

  async function tabAddress(tabId) {
    try {
      const tab = await c.tabs.get(tabId);
      const url = typeof tab?.url === "string" && tab.url ? tab.url : (typeof tab?.pendingUrl === "string" ? tab.pendingUrl : "");
      return { exists: true, url, ...splitAddress(url) };
    } catch {
      return { exists: false, url: "", host: "", path: "" };
    }
  }

  // 쪽 함수를 넣지 못했을 때 원인 가리기(spec-manual §4.4-8). 주소는 호스트 권한 범위(www.coupang.com)일 때만 보인다.
  async function classifyInjectFailure(tabId, navigated) {
    const address = await tabAddress(tabId);
    if (!address.exists) return { errorCode: "window_closed", host: "", path: "" };
    if (!address.url) return { errorCode: UNREADABLE_ERROR_CODE, host: "", path: "" };
    if (address.host === SEARCH_HOST && address.path === SEARCH_PATH) {
      return { errorCode: navigated ? "user_navigated" : "page_load_failed", host: address.host, path: address.path };
    }
    return { errorCode: "user_navigated", host: address.host, path: address.path };
  }

  async function quickRead(tabId) {
    try {
      const results = await withTimeout(c.scripting.executeScript({
        target: { tabId }, func: miCoupangMeasure, args: [{ ...measureOptions, quick: true }], injectImmediately: true,
      }), t.quickReadTimeoutMs);
      const raw = Array.isArray(results) ? results[0]?.result : null;
      if (raw && typeof raw === "object") return raw;
    } catch {
      // 못 읽으면 탭 주소만 쓴다.
    }
    const address = await tabAddress(tabId);
    return { host: address.host, path: address.path };
  }

  async function measureTab(run, tabId, keyword) {
    const loader = startLoadWatch(run, tabId);
    try {
      try {
        run.markNavigationIssued();
        const updated = await run.guard(c.tabs.update(tabId, { url: searchUrl(keyword) }));
        if (updated && (updated.status === "loading" || typeof updated.pendingUrl === "string")) loader.markStarted();
      } catch (error) {
        if (error instanceof StopError) throw error;
        return { notStarted: "window_create_failed" };
      }
      const how = await loader.wait();
      if (how === "timeout") {
        const raw = await quickRead(tabId);
        return { page: assemblePage(raw, { errorCode: "page_timeout" }) };
      }
      let results;
      run.setMeasuring(true);
      try {
        results = await run.guard(c.scripting.executeScript({ target: { tabId }, func: miCoupangMeasure, args: [measureOptions] }));
      } catch (error) {
        if (error instanceof StopError) throw error;
        const failure = await classifyInjectFailure(tabId, run.navigatedDuringMeasure);
        return { page: assemblePage({ host: failure.host, path: failure.path }, { errorCode: failure.errorCode }) };
      } finally {
        run.setMeasuring(false);
      }
      const raw = Array.isArray(results) ? results[0]?.result : null;
      if (!raw || typeof raw !== "object") {
        const failure = await classifyInjectFailure(tabId, run.navigatedDuringMeasure);
        const code = failure.errorCode === "page_load_failed" ? "extract_failed" : failure.errorCode;
        return { page: assemblePage({ host: failure.host, path: failure.path }, { errorCode: code }) };
      }
      return { page: assemblePage(raw) };
    } finally {
      loader.cancel();
    }
  }

  async function firstTabId(win) {
    const fromCreate = Array.isArray(win.tabs) ? win.tabs[0]?.id : undefined;
    if (Number.isInteger(fromCreate)) return fromCreate;
    try {
      const tabs = await c.tabs.query({ windowId: win.id });
      return Array.isArray(tabs) && Number.isInteger(tabs[0]?.id) ? tabs[0].id : null;
    } catch {
      return null;
    }
  }

  async function closeWindow(windowId, run) {
    if (run?.windowGone) return { leftOpen: false };
    try {
      await withTimeout(c.windows.remove(windowId), t.closeTimeoutMs);
      return { leftOpen: false };
    } catch {
      try {
        const win = await c.windows.get(windowId);
        return { leftOpen: Boolean(win) };
      } catch {
        return { leftOpen: false };
      }
    }
  }

  async function openAndMeasure({ claimId, claimToken, keyword, serverDay }) {
    let win;
    try {
      // 빈 창을 먼저 열어 정말 시크릿인지 본 뒤에만 쿠팡 주소를 넣는다(어긋나면 쿠팡 요청 0번).
      win = await c.windows.create({
        url: "about:blank", incognito: true, focused: true, type: "normal", width: WINDOW_WIDTH, height: WINDOW_HEIGHT,
      });
    } catch {
      return notStarted("window_create_failed", claimId);
    }
    if (!win || !Number.isInteger(win.id)) {
      // 시크릿 허용이 꺼진 채 만들면 크롬은 창을 만들고 값만 비워 준다: 빈 창이 남을 수 있다(쿠팡 요청은 없음).
      return notStarted("window_create_null", claimId, { windowLeftOpen: true });
    }
    if (win.incognito !== true) {
      const closed = await closeWindow(win.id, null);
      return notStarted("window_create_failed", claimId, { windowLeftOpen: closed.leftOpen });
    }
    const windowId = win.id;
    const startedAt = now();
    state.activeWindowId = windowId;
    await save({ active: { windowId, claimId, startedAt } });
    const run = createRun(windowId);
    let result;
    let unexpected = null;
    try {
      const tabId = await run.guard(firstTabId(win));
      if (!Number.isInteger(tabId)) {
        result = { notStarted: "window_create_failed" };
      } else if (await run.guard(incognitoWindowOpen(windowId))) {
        result = { notStarted: "incognito_window_open" };
      } else {
        run.watchTab(tabId);
        await save({ lastCheckAt: now() });
        try {
          result = await measureTab(run, tabId, keyword);
        } catch (error) {
          if (!(error instanceof StopError)) throw error;
          if (error.code === "browser_hard_cap" && !run.windowGone) {
            result = { page: assemblePage(await quickRead(tabId), { errorCode: "browser_hard_cap" }) };
          } else {
            result = { page: assemblePage({}, { errorCode: error.code === "browser_hard_cap" ? "browser_hard_cap" : "window_closed" }) };
          }
        }
      }
    } catch (error) {
      if (error instanceof StopError) result = { notStarted: "window_create_failed" };
      else unexpected = error;
    } finally {
      run.dispose();
    }
    // 예기치 못한 오류여도 창은 닫는다. 쿠팡 주소를 넣은 뒤였다면 검색이 됐을 수 있으므로 '측정 실패'로 답한다.
    const closed = await closeWindow(windowId, run);
    if (!closed.leftOpen) await drop("active");
    if (unexpected) {
      if (!run.navigationIssued) throw unexpected;
      result = { page: assemblePage({}, { errorCode: "extract_failed" }) };
    }
    if (result.notStarted) return notStarted(result.notStarted, claimId, { windowLeftOpen: closed.leftOpen });

    const page = result.page;
    const durationMs = Math.max(0, Math.min(DURATION_MAX_MS, now() - startedAt));
    const stopReason = stopReasonOf(page);
    // 차단 신호는 화면 보고와 따로 서버에 바로 알린다(관리자 탭이 닫혀도 그날 중지가 걸리게).
    const stopReported = stopReason ? await sendStop(claimId, claimToken, stopReason, serverDay) : false;
    const reply = {
      ok: true,
      outcome: "measured",
      claimId,
      keyword,
      page,
      durationMs,
      extensionVersion: EXTENSION_VERSION,
      browser,
      windowLeftOpen: closed.leftOpen,
      stopSignal: Boolean(stopReason),
      stopReason,
      stopReported,
    };
    await save({
      pending: { claimId, claimToken, reply, savedAt: now(), serverDay, stop: Boolean(stopReason), stopReason, stopReported },
      ...(stopReason ? { blockedDay: serverDay } : {}),
    });
    return reply;
  }

  function respond(sendResponse, reply) {
    try {
      sendResponse(reply);
    } catch {
      // 화면이 닫혀 답을 받을 곳이 없다. 결과는 pending 에 남아 있다.
    }
  }

  function listener(message, sender, sendResponse) {
    if (!isAllowedSender(sender)) {
      respond(sendResponse, { ok: false, code: "origin_rejected" });
      return false;
    }
    const parsed = parseMessage(message);
    let work;
    if (parsed.type === "hello") work = hello();
    else if (parsed.type === "ack") work = ack(parsed);
    else if (parsed.type === "check" && !parsed.invalid) work = check(parsed);
    else if (parsed.type === "check") work = Promise.resolve(notStarted("bad_request", null));
    else {
      respond(sendResponse, { ok: false, code: "bad_request" });
      return false;
    }
    work.then(
      (reply) => respond(sendResponse, reply),
      () => respond(sendResponse, { ok: false, code: "extension_error" }),
    );
    return true;
  }

  return {
    listener,
    state,
    start() {
      state.ready = cleanupLeftover().catch(() => {});
      return state.ready;
    },
    hello,
    check,
    ack,
  };
}

export function startBackground(chromeApi, deps) {
  const background = createBackground(chromeApi, deps);
  chromeApi.runtime.onMessageExternal.addListener(background.listener);
  background.start();
  return background;
}

// 크롬 안에서만 시작한다(Node 테스트는 createBackground 를 가짜 chrome 으로 부른다).
const chromeGlobal = globalThis.chrome;
if (chromeGlobal && chromeGlobal.runtime && typeof chromeGlobal.runtime.id === "string" && chromeGlobal.runtime.onMessageExternal) {
  startBackground(chromeGlobal);
}

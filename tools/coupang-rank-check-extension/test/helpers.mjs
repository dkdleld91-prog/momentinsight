// 확장 테스트 공용 도구: 가짜 chrome API·가짜 fetch·보낸 쪽. 실제 크롬·쿠팡·운영 서버에는 요청하지 않는다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(EXTENSION_ROOT, "..", "..");
export const SHIPPED_FILES = ["background.js", "lib/assemble.js", "lib/measure.js", "lib/protocol.js", "manifest.json"];

export function readExtension(rel) {
  return fs.readFileSync(path.join(EXTENSION_ROOT, rel), "utf8");
}

export function readRepo(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

export function fixture(name) {
  return JSON.parse(readRepo(`tools/coupang-rank-collector/test/fixtures/${name}`));
}

export const CLAIM_ID = "0b8f3c1e-2a4d-4e6f-9a1b-3c5d7e9f1a2b";
export const CLAIM_ID_2 = "1c9a4d2f-3b5e-4f70-8b2c-4d6e8f0a2b3c";
export const CLAIM_ID_3 = "2dab5e3a-4c6f-4a81-9c3d-5e7f9a1b3c4d";
export const CLAIM_TOKEN = `mcm1_${"A".repeat(40)}x_-`;
export const SERVER_KEYWORD = "아이폰 케이스";
export const ADMIN_SENDER = Object.freeze({
  origin: "https://insight.momentlabs.co.kr",
  url: "https://insight.momentlabs.co.kr/admin#coupang",
  frameId: 0,
  tab: { id: 7, incognito: false },
});
export const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export const FAST_TIMING = Object.freeze({
  loadTimeoutMs: 120,
  hardCapMs: 600,
  keepaliveMs: 15,
  probeIntervalMs: 10,
  quickReadTimeoutMs: 40,
  closeTimeoutMs: 40,
  verifyTimeoutMs: 80,
  stopRetryDelaysMs: [5, 5],
});

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function makeEvent() {
  const listeners = new Set();
  return {
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); },
    hasListener(fn) { return listeners.has(fn); },
    emit(...args) { for (const fn of [...listeners]) fn(...args); },
    get size() { return listeners.size; },
  };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// 쪽 함수 결과(쿠팡 검색 1쪽). 수집기 고정본을 읽기 결과 모양으로 바꾼다.
export function rawPage(overrides = {}) {
  const base = fixture("page-full.json");
  return {
    host: base.host,
    path: base.path,
    query: SERVER_KEYWORD,
    blockedText: base.blockedText,
    noResultText: base.noResultText,
    loginWall: base.loginWall,
    items: base.items,
    httpStatus: 200,
    stable: true,
    navigated: false,
    scrolls: 8,
    reads: 3,
    wasHidden: false,
    visibility: "visible",
    ...overrides,
  };
}

// 가짜 chrome. scenario 로 탭 이동·쪽 함수 결과를 바꾼다.
export function makeFakeChrome(options = {}) {
  const log = [];
  // update = tabs.update(쿠팡 이동), windowsUpdate = windows.update(창 앞으로 가져오기)
  const calls = { create: [], remove: [], update: [], windowsUpdate: [], executeScript: [], getAll: [], windowsGet: [], tabsGet: [], query: [] };
  const windows = new Map();
  const tabs = new Map();
  let nextWindowId = 500;
  let nextTabId = 9000;
  const storageData = clone(options.storage || {});
  const events = {
    onMessageExternal: makeEvent(),
    windowsOnRemoved: makeEvent(),
    tabsOnUpdated: makeEvent(),
    tabsOnRemoved: makeEvent(),
  };
  const config = {
    incognitoAllowed: true,
    permissions: true, // true | false | "missing" | "throw"
    createBehavior: "ok", // ok | null | throw | normal
    tabsInCreate: true,
    getAllWithTypes: "ok", // ok | throw
    getAllDefault: "ok", // ok | throw
    removeFails: false,
    focusFails: false,
    extraIncognitoAfterCreate: false,
    ...options,
  };
  const scenario = {
    // 탭 이동: url → 최종 주소(로그인 화면으로 보내기 등). null 이면 이동 이벤트를 보내지 않는다.
    finalUrl: (url) => url,
    loadEvents: true,
    loadDelayMs: 5,
    // 쪽 함수: 기본은 정상 검색 1쪽.
    measure: () => rawPage(),
    quick: () => rawPage({ items: [], stable: false, scrolls: 0, reads: 1 }),
    probe: () => { throw new Error("Cannot access contents of the page"); },
    ...(options.scenario || {}),
  };
  for (const win of options.windows || []) windows.set(win.id, { type: "normal", ...win });

  function visibleUrl(url) {
    const host = hostOf(url);
    return host === "www.coupang.com" || host === "insight.momentlabs.co.kr" ? url : undefined;
  }
  function canSee(win) {
    return win && (!win.incognito || config.incognitoAllowed);
  }
  function tabView(tab) {
    return { id: tab.id, windowId: tab.windowId, status: tab.status, url: visibleUrl(tab.url), pendingUrl: tab.pendingUrl ? visibleUrl(tab.pendingUrl) : undefined, incognito: tab.incognito };
  }
  function removeWindowNow(id) {
    const win = windows.get(id);
    if (!win) return false;
    windows.delete(id);
    for (const [tabId, tab] of tabs) {
      if (tab.windowId === id) {
        tabs.delete(tabId);
        queueMicrotask(() => events.tabsOnRemoved.emit(tabId, { windowId: id, isWindowClosing: true }));
      }
    }
    queueMicrotask(() => events.windowsOnRemoved.emit(id));
    return true;
  }

  const chrome = {
    runtime: { id: "onbmdfamcmbljplkgalameendlmgnjeg", onMessageExternal: events.onMessageExternal },
    extension: {
      async isAllowedIncognitoAccess() {
        log.push("isAllowedIncognitoAccess");
        return typeof config.incognitoAllowed === "function" ? config.incognitoAllowed() : config.incognitoAllowed;
      },
    },
    management: { async getSelf() { return { installType: "development", id: "onbmdfamcmbljplkgalameendlmgnjeg" }; } },
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (Object.hasOwn(storageData, key)) out[key] = clone(storageData[key]);
          return out;
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) storageData[key] = clone(value);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
        },
      },
    },
    windows: {
      onRemoved: events.windowsOnRemoved,
      async getAll(filter) {
        calls.getAll.push(clone(filter));
        log.push("windows.getAll");
        if (filter && filter.windowTypes && config.getAllWithTypes === "throw") throw new Error("Invalid value for argument 1");
        if (!filter && config.getAllDefault === "throw") throw new Error("getAll failed");
        const list = [...windows.values()].filter(canSee).map((win) => ({ id: win.id, incognito: win.incognito, type: win.type }));
        if (config.extraIncognitoAfterCreate && calls.create.length > 0) list.push({ id: 999, incognito: true, type: "normal" });
        return list;
      },
      async get(id) {
        calls.windowsGet.push(id);
        const win = windows.get(id);
        if (!canSee(win)) throw new Error(`No window with id: ${id}.`);
        return { id: win.id, incognito: win.incognito, type: win.type };
      },
      async create(createData) {
        calls.create.push(clone(createData));
        log.push("windows.create");
        if (config.createBehavior === "throw") throw new Error("Incognito mode is disabled by policy");
        const id = nextWindowId += 1;
        const incognito = config.createBehavior === "normal" ? false : createData.incognito === true;
        windows.set(id, { id, incognito, type: "normal", focused: createData.focused === true });
        const tabId = nextTabId += 1;
        tabs.set(tabId, { id: tabId, windowId: id, url: createData.url, status: "complete", incognito });
        if (config.createBehavior === "null") return undefined;
        return { id, incognito, type: "normal", tabs: config.tabsInCreate ? [tabView(tabs.get(tabId))] : undefined };
      },
      async update(id, updateInfo) {
        calls.windowsUpdate.push({ id, ...clone(updateInfo) });
        log.push("windows.update");
        if (config.focusFails) throw new Error("update failed");
        const win = windows.get(id);
        if (!canSee(win)) throw new Error(`No window with id: ${id}.`);
        if (updateInfo && updateInfo.focused === true) win.focused = true;
        return { id: win.id, incognito: win.incognito, type: win.type, focused: win.focused === true };
      },
      async remove(id) {
        calls.remove.push(id);
        log.push("windows.remove");
        if (config.removeFails) throw new Error("remove failed");
        if (!removeWindowNow(id)) throw new Error(`No window with id: ${id}.`);
      },
    },
    tabs: {
      onUpdated: events.tabsOnUpdated,
      onRemoved: events.tabsOnRemoved,
      async query(info) {
        calls.query.push(clone(info));
        return [...tabs.values()].filter((tab) => tab.windowId === info.windowId).map(tabView);
      },
      async get(id) {
        calls.tabsGet.push(id);
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tabView(tab);
      },
      async update(id, props) {
        calls.update.push({ id, ...clone(props) });
        log.push("tabs.update");
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        tab.pendingUrl = props.url;
        tab.status = "loading";
        const finalUrl = scenario.finalUrl(props.url);
        if (scenario.loadEvents && finalUrl !== null) {
          setTimeout(() => {
            if (!tabs.has(id)) return;
            events.tabsOnUpdated.emit(id, { status: "loading" }, tabView(tab));
            setTimeout(() => {
              if (!tabs.has(id)) return;
              tab.url = finalUrl;
              tab.pendingUrl = undefined;
              tab.status = "complete";
              events.tabsOnUpdated.emit(id, { status: "complete" }, tabView(tab));
            }, scenario.loadDelayMs);
          }, 1);
        } else if (finalUrl !== null) {
          tab.url = finalUrl;
          tab.pendingUrl = undefined;
        }
        return { ...tabView(tab), status: "loading" };
      },
    },
    scripting: {
      async executeScript(injection) {
        calls.executeScript.push({ tabId: injection.target?.tabId, func: injection.func?.name, args: clone(injection.args), injectImmediately: injection.injectImmediately === true });
        const tab = tabs.get(injection.target?.tabId);
        if (!tab) throw new Error("No tab with id");
        const ctx = { tab, chrome: fake, injection };
        let result;
        if (injection.func?.name === "miCoupangProbe") {
          log.push("probe");
          result = await scenario.probe(ctx);
        } else if (injection.args?.[0]?.quick === true) {
          log.push("quick");
          result = await scenario.quick(ctx);
        } else {
          log.push("measure");
          result = await scenario.measure(ctx);
        }
        return [{ frameId: 0, documentId: "doc", result }];
      },
    },
  };
  if (config.permissions !== "missing") {
    chrome.permissions = {
      async contains(query) {
        log.push("permissions.contains");
        if (config.permissions === "throw") throw new Error("permissions failed");
        return typeof config.permissions === "function" ? config.permissions(query) : config.permissions;
      },
    };
  }
  const fake = {
    chrome,
    calls,
    log,
    windows,
    tabs,
    storage: storageData,
    events,
    config,
    scenario,
    closeWindowByUser(id) { removeWindowNow(id); },
    openIncognitoWindow(id = 777) { windows.set(id, { id, incognito: true, type: "normal" }); return id; },
    lastWindowId() { return nextWindowId; },
  };
  return fake;
}

// 가짜 서버(GET manual-verify·manual-stop). handler(url, init) → { status, body } | { status, text } | Error.
// handler 가 없으면 기본 서버: 확인은 요청마다 한 번만(두 번째는 CLAIM_USED), 중지는 늘 받는다.
export function makeFakeFetch(handler, log = null, options = {}) {
  const calls = [];
  const used = new Set();
  const serverTime = options.serverTime || null;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    const view = parsed.searchParams.get("view");
    if (log) log.push(view === "manual-stop" ? "fetch:stop" : "fetch");
    let outcome;
    if (handler) outcome = await handler(url, init, { view, used });
    else if (view === "manual-stop") outcome = { status: 200, body: { ok: true, stopped: true, stoppedDay: "2026-10-23", stopCode: parsed.searchParams.get("reason") } };
    else {
      const claimId = parsed.searchParams.get("claimId");
      if (used.has(claimId)) outcome = { status: 409, body: { ok: false, code: "COUPANG_MANUAL_CLAIM_USED" } };
      else {
        used.add(claimId);
        outcome = defaultVerify(url, init, { serverTime: typeof serverTime === "function" ? serverTime() : serverTime || undefined });
      }
    }
    if (outcome instanceof Error) throw outcome;
    const text = typeof outcome.text === "string" ? outcome.text : JSON.stringify(outcome.body ?? null);
    return { status: outcome.status, async text() { return text; } };
  };
  fetchImpl.calls = calls;
  fetchImpl.views = () => calls.map((call) => new URL(call.url).searchParams.get("view"));
  fetchImpl.stops = () => calls.filter((call) => new URL(call.url).searchParams.get("view") === "manual-stop").map((call) => {
    const parsed = new URL(call.url);
    return { claimId: parsed.searchParams.get("claimId"), reason: parsed.searchParams.get("reason"), token: call.init.headers["x-mi-coupang-claim-token"] };
  });
  return fetchImpl;
}

export function defaultVerify(url, init, { keyword = SERVER_KEYWORD, serverTime = new Date().toISOString() } = {}) {
  const claimId = new URL(url).searchParams.get("claimId");
  return { status: 200, body: { ok: true, verified: true, claimId, keyword, keywordKey: keyword, verifiedAt: serverTime, recordUntil: serverTime, serverTime } };
}

// background 의 listener 로 메시지를 보내고 답을 받는다.
export function send(background, message, sender = ADMIN_SENDER) {
  return new Promise((resolve) => {
    const returned = background.listener(message, sender, resolve);
    if (returned !== true && returned !== false) throw new Error("listener must return a boolean");
  });
}

export function checkMessage(overrides = {}) {
  return { type: "mi-coupang-check", claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, keyword: "화면이 보낸 검색어", ...overrides };
}

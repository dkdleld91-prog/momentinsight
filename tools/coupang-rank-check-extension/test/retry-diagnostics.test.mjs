// 1.0.1(대표 승인 2026-10-24): 쪽이 스스로 다시 불러오면 한 번 더 읽기 + 어느 길로 끝나든 실패 진단(page.diagnostics).
// 가짜 chrome·가짜 서버만 쓴다(쿠팡·운영 서버 요청 0). 새로고침은 가짜 탭의 loading → complete 사건으로 흉내 낸다.
import assert from "node:assert/strict";
import test from "node:test";
import { createBackground } from "../background.js";
import { buildDiagnostics, diagnosticText, diagnosticsBytes } from "../lib/assemble.js";
import { DIAGNOSTICS_MAX_BYTES, EXTENSION_VERSION, searchUrl } from "../lib/protocol.js";
import { manualDiagnostics } from "../../../src/server/coupang-rank/manual.mjs";
import { validateManualRecord } from "../../../src/server/coupang-rank/page-result.mjs";
import { CHROME_UA, CLAIM_ID, FAST_TIMING, checkMessage, makeFakeChrome, makeFakeFetch, rawPage, send, sleep } from "./helpers.mjs";

const ZERO_MEASURE = { settleMs: 0, gapMin: 0, gapMax: 0, readGapMs: 0 };
const LOGIN_URL = "https://login.coupang.com/login/login.pang?rtnUrl=x";

function setup({ chrome: chromeOptions = {}, timing = {} } = {}) {
  const fake = makeFakeChrome(chromeOptions);
  const fetchImpl = makeFakeFetch(null, fake.log);
  let tick = 0;
  const background = createBackground(fake.chrome, {
    fetch: fetchImpl,
    timing: { ...FAST_TIMING, ...timing },
    measure: ZERO_MEASURE,
    uaText: CHROME_UA,
    monoNow: () => { tick += 7; return tick; },
  });
  return { fake, fetchImpl, background };
}

const measures = (fake) => fake.calls.executeScript.filter((call) => call.func === "miCoupangMeasure" && call.args?.[0]?.quick !== true).length;

// 쪽이 스스로 다시 불러온다: 탭 loading 사건 → (delay 뒤) complete 사건. delay 가 null 이면 끝나지 않는다.
function selfReload(fake, tab, delay = 15) {
  tab.status = "loading";
  fake.events.tabsOnUpdated.emit(tab.id, { status: "loading" });
  if (delay === null) return;
  setTimeout(() => {
    tab.status = "complete";
    fake.events.tabsOnUpdated.emit(tab.id, { status: "complete" });
  }, delay);
}

// 결과 진단은 서버가 그대로 받는 모양이어야 한다(서버 검사 통과·본문 검사 통과).
function assertServerAccepts(reply) {
  const body = { claimId: CLAIM_ID, page: reply.page, durationMs: reply.durationMs, extensionVersion: reply.extensionVersion, browser: reply.browser };
  assert.deepEqual(validateManualRecord(body), { ok: true }, "진단이 있어도 결과 본문 검사는 그대로 통과");
  assert.deepEqual(manualDiagnostics(body), JSON.parse(JSON.stringify(reply.page.diagnostics)), "서버 진단 검사 통과");
  assert.ok(diagnosticsBytes(reply.page.diagnostics) <= DIAGNOSTICS_MAX_BYTES);
}

test("쪽이 측정 중 스스로 새로고침해 결과 없이 끝나면 → 다시 뜰 때까지 기다렸다가 1번 더 읽어 ok(쿠팡 주소 넣기는 1번뿐)", async () => {
  let count = 0;
  const { fake, fetchImpl, background } = setup({
    chrome: {
      scenario: {
        measure: ({ tab, chrome: fakeRef }) => {
          count += 1;
          if (count === 1) {
            selfReload(fakeRef, tab);
            return undefined; // 문서가 바뀌어 결과 없이 끝남
          }
          return rawPage();
        },
      },
    },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.outcome, "measured");
  assert.equal(reply.page.status, "ok");
  assert.equal(reply.page.errorCode, null);
  assert.equal(reply.page.organic.length, 50);
  assert.equal(fake.calls.update.length, 1, "쿠팡 주소를 다시 넣지 않는다(새 검색 0)");
  assert.equal(fake.calls.update[0].url, searchUrl("아이폰 케이스"));
  assert.equal(measures(fake), 2, "측정은 최대 2번");
  assert.equal(fetchImpl.views().filter((view) => view === "manual-verify").length, 1);
  const diag = reply.page.diagnostics;
  assert.deepEqual(Object.keys(diag), ["v", "ext", "ok", "code", "ms", "load", "retry", "tries"], "성공은 짧게(재시도했으면 시도 종류까지)");
  assert.deepEqual([diag.v, diag.ext, diag.ok, diag.code], [1, EXTENSION_VERSION, true, null]);
  assert.deepEqual(diag.retry, { tried: true, load: "complete", result: "measured" });
  assert.deepEqual(diag.tries, [{ kind: "no_result" }, { kind: "ok" }]);
  assert.ok(diag.load.loading >= 2 && diag.load.complete >= 2, `load 사건 ${JSON.stringify(diag.load)}`);
  assert.equal(diag.load.completeAt.length, diag.load.complete);
  for (const name of ["verified", "nav", "load", "quick", "measureStart", "measureEnd", "retryStart", "retryLoad", "retryQuick", "retryMeasureStart", "retryMeasureEnd", "end"]) {
    assert.ok(Number.isInteger(diag.ms[name]) && diag.ms[name] >= 0, `ms.${name}`);
  }
  assert.ok(diag.ms.verified < diag.ms.nav && diag.ms.nav < diag.ms.measureStart && diag.ms.retryStart < diag.ms.retryMeasureEnd && diag.ms.retryMeasureEnd <= diag.ms.end);
  assertServerAccepts(reply);
});

test("두 번째도 결과가 없으면 지금처럼 extract_failed — 진단에 시도 종류·쪽 모양(제목·본문 앞부분·상품 칸 수)·load 횟수가 남는다", async () => {
  const doc = { nav: "navigate", ready: "complete", title: "아이폰 케이스 - 쿠팡!", bodyLen: 4210, bodyHead: "쿠팡 로그인 회원가입 고객센터", units: 0, links: 0, blocked: false, hidden: false };
  const { fake, fetchImpl, background } = setup({
    chrome: { scenario: { measure: () => undefined, quick: () => rawPage({ items: [], stable: false, scrolls: 0, reads: 1, doc }) } },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "extract_failed");
  assert.equal(reply.page.finalPath, "/np/search");
  assert.equal(reply.stopSignal, false);
  assert.deepEqual(fetchImpl.stops(), []);
  assert.equal(fake.calls.update.length, 1);
  assert.equal(measures(fake), 2);
  const diag = reply.page.diagnostics;
  assert.deepEqual([diag.ok, diag.code], [false, "extract_failed"]);
  assert.deepEqual(diag.retry, { tried: true, load: "already", result: "failed" }, "탭이 이미 다 불러온 상태면 기다리지 않고 바로 읽는다");
  assert.deepEqual(diag.tries, [{ kind: "no_result" }, { kind: "no_result" }]);
  assert.deepEqual(diag.doc, doc);
  assert.equal(diag.hidden, false);
  assert.deepEqual([diag.load.loading, diag.load.complete], [1, 1], "스스로 다시 불러오지 않았다(loading → complete 1번)");
  assertServerAccepts(reply);
});

test("쪽 함수를 못 넣음(rejected)·쪽 안 예외(extractError)도 같은 검색 1쪽이면 1번 더 읽는다 — 오류 문구 앞 200자(주소 쿼리 뗌)", async () => {
  let rejectedOnce = false;
  const rejected = setup({
    chrome: {
      scenario: {
        measure: () => {
          if (!rejectedOnce) {
            rejectedOnce = true;
            throw new Error("Frame with ID 0 was removed. https://www.coupang.com/np/search?q=secret#x");
          }
          return rawPage();
        },
      },
    },
  });
  const first = await send(rejected.background, checkMessage());
  assert.equal(first.page.status, "ok");
  assert.deepEqual(first.page.diagnostics.tries, [{ kind: "rejected", msg: "Frame with ID 0 was removed. https://www.coupang.com/np/search" }, { kind: "ok" }]);
  assert.equal(JSON.stringify(first.page.diagnostics).includes("secret"), false, "주소의 쿼리 값은 남기지 않는다");
  assert.equal(rejected.fake.calls.update.length, 1);

  let thrownOnce = false;
  const thrown = setup({
    chrome: {
      scenario: {
        measure: () => {
          if (!thrownOnce) {
            thrownOnce = true;
            return { extractError: true, host: "www.coupang.com", path: "/np/search", query: "", items: [], httpStatus: 200, error: "TypeError: x is null\n at read", doc: { nav: "reload", ready: "interactive", units: 3 } };
          }
          return rawPage();
        },
      },
    },
  });
  const second = await send(thrown.background, checkMessage());
  assert.equal(second.page.status, "ok");
  assert.deepEqual(second.page.diagnostics.tries, [{ kind: "extract_error", msg: "TypeError: x is null at read" }, { kind: "ok" }]);
  assert.equal(measures(thrown.fake), 2);
  // 두 번 다 넣지 못하면 지금처럼 page_load_failed
  const always = setup({ chrome: { scenario: { measure: () => { throw new Error("Frame with ID 0 is showing error page"); } } } });
  const failed = await send(always.background, checkMessage());
  assert.equal(failed.page.errorCode, "page_load_failed");
  assert.deepEqual(failed.page.diagnostics.retry, { tried: true, load: "already", result: "failed" });
  assert.equal(always.fake.calls.update.length, 1);
});

test("측정 중 사람이 주소를 바꿨으면(다른 쪽·쿼리 값 바뀜) 1번 더 읽지 않는다 — user_navigated 그대로", async () => {
  for (const [nextUrl, path] of [
    [() => "https://www.coupang.com/vp/products/12345678", "/vp/products/12345678"],
    [(url) => `${url}&sorter=saleCountDesc`, "/np/search"],
  ]) {
    const { fake, background } = setup({
      chrome: {
        scenario: {
          measure: ({ tab, chrome: fakeRef }) => {
            const url = nextUrl(tab.url);
            tab.url = url;
            fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading", url });
            return undefined;
          },
        },
      },
    });
    const reply = await send(background, checkMessage());
    assert.equal(reply.page.errorCode, "user_navigated", path);
    assert.equal(reply.page.finalPath, path);
    assert.equal(measures(fake), 1, "다시 읽지 않는다");
    assert.deepEqual(reply.page.diagnostics.retry, { tried: false, skip: "address_changed" });
    assert.equal(fake.calls.update.length, 1);
  }
  // 측정 중 주소 없이 다시 불러오기 시작 → 로그인 화면(권한 밖)으로 보내짐: 다시 읽지 않고 page_unreadable(D1 그날 중지)
  const login = setup({
    chrome: {
      scenario: {
        measure: ({ tab, chrome: fakeRef }) => {
          tab.url = LOGIN_URL;
          fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading" });
          return undefined;
        },
      },
    },
  });
  const reply = await send(login.background, checkMessage());
  assert.equal(reply.page.errorCode, "page_unreadable");
  assert.equal(reply.stopReason, "page_unreadable");
  assert.deepEqual(reply.page.diagnostics.retry, { tried: false, skip: "not_search" });
  assert.equal(measures(login.fake), 1);
});

test("차단이면 다시 읽지 않는다: 첫 측정이 차단 HTTP 를 보였거나, 다시 읽기 전 짧은 읽기가 차단 화면이면 그날 중지(지금처럼)", async () => {
  const blockedFirst = setup({
    chrome: { scenario: { measure: () => ({ extractError: true, host: "www.coupang.com", path: "/np/search", query: "", items: [], httpStatus: 403, error: "boom" }) } },
  });
  const first = await send(blockedFirst.background, checkMessage());
  assert.equal(first.page.errorCode, "extract_failed");
  assert.equal(first.stopReason, "blocked_http_403");
  assert.deepEqual(blockedFirst.fetchImpl.stops().map((stop) => stop.reason), ["blocked_http_403"]);
  assert.deepEqual(first.page.diagnostics.retry, { tried: false, skip: "blocked" });
  assert.equal(measures(blockedFirst.fake), 1);

  let quicks = 0;
  const blockedAfterReload = setup({
    chrome: {
      scenario: {
        measure: ({ tab, chrome: fakeRef }) => {
          selfReload(fakeRef, tab);
          return undefined;
        },
        quick: () => {
          quicks += 1;
          return quicks === 1
            ? rawPage({ items: [], stable: false, scrolls: 0, reads: 1 })
            : rawPage({ httpStatus: 200, items: [], blockedText: true, stable: false, scrolls: 0, reads: 1 });
        },
      },
    },
  });
  const second = await send(blockedAfterReload.background, checkMessage());
  assert.equal(second.page.status, "blocked");
  assert.equal(second.stopReason, "blocked_text");
  assert.deepEqual(blockedAfterReload.fetchImpl.stops().map((stop) => stop.reason), ["blocked_text"]);
  assert.equal(measures(blockedAfterReload.fake), 1, "차단 화면에서는 측정(스크롤)하지 않는다");
  assert.deepEqual(second.page.diagnostics.retry, { tried: true, load: "complete", result: "blocked" });
  assert.equal(blockedAfterReload.fake.calls.update.length, 1);
  assert.ok(blockedAfterReload.fake.storage.blockedDay);
});

test("다시 불러오기가 끝나지 않으면 기존 load 상한(45초 — 시험은 짧게) 뒤 page_timeout, 전체 120초 상한·창 닫힘 규칙은 그대로", async () => {
  const hung = setup({
    chrome: { scenario: { measure: ({ tab, chrome: fakeRef }) => { selfReload(fakeRef, tab, null); return undefined; } } },
    timing: { loadTimeoutMs: 60, hardCapMs: 2000 },
  });
  const reply = await send(hung.background, checkMessage());
  assert.equal(reply.page.errorCode, "page_timeout");
  assert.deepEqual(reply.page.diagnostics.retry, { tried: true, load: "timeout", result: "timeout" });
  assert.equal(measures(hung.fake), 1);
  assert.equal(hung.fake.calls.update.length, 1);

  const capped = setup({
    chrome: { scenario: { measure: ({ tab, chrome: fakeRef }) => { selfReload(fakeRef, tab, null); return undefined; } } },
    timing: { loadTimeoutMs: 5000, hardCapMs: 80 },
  });
  const cap = await send(capped.background, checkMessage());
  assert.equal(cap.page.errorCode, "browser_hard_cap");
  assert.equal(cap.page.diagnostics.code, "browser_hard_cap");
  assert.equal(capped.fake.windows.size, 0, "창은 닫는다");

  let fakeRef;
  const closed = setup({
    chrome: {
      scenario: {
        measure: ({ tab, chrome: current }) => {
          selfReload(current, tab, null);
          setTimeout(() => fakeRef.closeWindowByUser(tab.windowId), 10);
          return undefined;
        },
      },
    },
    timing: { loadTimeoutMs: 5000 },
  });
  fakeRef = closed.fake;
  const gone = await send(closed.background, checkMessage());
  assert.equal(gone.page.errorCode, "window_closed");
  assert.equal(gone.page.diagnostics.code, "window_closed");
});

test("진단은 어느 실패 길에서든 남는다: 시간 초과·창 닫음·120초 상한·권한 밖·예기치 못한 오류·첫 읽기 차단 — 서버 검사 통과", async () => {
  let fakeRef;
  const cases = [
    ["page_timeout", { chrome: { scenario: { loadEvents: false, quick: () => ({ host: "www.coupang.com", path: "/np/search", httpStatus: 200, items: [] }) } }, timing: { loadTimeoutMs: 40 } }],
    ["window_closed", { chrome: { scenario: { measure: async ({ tab }) => { fakeRef.closeWindowByUser(tab.windowId); await sleep(500); return rawPage(); } } } }],
    ["browser_hard_cap", { chrome: { scenario: { measure: () => new Promise(() => {}) } }, timing: { hardCapMs: 80 } }],
    ["page_unreadable", { chrome: { scenario: { finalUrl: () => LOGIN_URL, measure: () => { throw new Error("Cannot access contents of url \"https://login.coupang.com/login/login.pang?rtnUrl=secret\""); } } } }],
    ["extract_failed", { chrome: { scenario: { measure: () => new Proxy({}, { get(_, key) { if (key === "then") return undefined; throw new TypeError("bad result"); } }) } } }],
    [null, { chrome: { scenario: { quick: () => rawPage({ httpStatus: 403, items: [], stable: false }) } } }],
  ];
  for (const [code, options] of cases) {
    const current = setup(options);
    fakeRef = current.fake;
    const reply = await send(current.background, checkMessage());
    const label = String(code);
    assert.equal(reply.outcome, "measured", label);
    assert.equal(reply.page.errorCode, code, label);
    const diag = reply.page.diagnostics;
    assert.equal(diag.v, 1, label);
    assert.equal(diag.ext, EXTENSION_VERSION, label);
    assert.equal(diag.code, code, label);
    assert.equal(diag.ok, false, label);
    assert.ok(Number.isInteger(diag.ms.end), label);
    assert.equal(JSON.stringify(diag).includes("secret"), false, `${label}: 쿼리 값 없음`);
    assertServerAccepts(reply);
    if (code === "extract_failed") assert.equal(diag.unexpected, "bad result");
    if (code === null) assert.equal(reply.page.status, "blocked");
    assert.equal(current.fake.calls.update.length, 1, label);
  }
});

test("buildDiagnostics: 4KB 상한(덜 중요한 것부터 덜어 냄·cut)·제어 문자·깨진 글자·주소 쿼리 정리·성공은 짧게", () => {
  const big = "가".repeat(400);
  const doc = { nav: "reload", ready: "complete", title: big, bodyLen: 99999, bodyHead: `${big}\u0000\n\t끝`, units: 2, links: 4, blocked: false, hidden: true };
  const input = {
    version: "1.0.1",
    page: { status: "error", errorCode: "extract_failed", wasHidden: false },
    ms: { verified: 1.4, nav: -3, load: 1e12, bad: Number.NaN, "1x": 3 },
    load: { how: "complete", loading: 3, complete: 3, urls: 1, completeAt: Array.from({ length: 9 }, (_, index) => index * 100) },
    tries: Array.from({ length: 6 }, () => ({ kind: "rejected", msg: `${big} https://www.coupang.com/np/search?q=비밀&x=1 \ud800` })),
    doc,
    firstDoc: { ...doc, nav: "navigate" },
    retry: { tried: true, load: "already", result: "failed", skip: "Not A Word" },
    hidden: true,
    unexpected: big,
  };
  const out = buildDiagnostics(input);
  assert.ok(diagnosticsBytes(out) <= DIAGNOSTICS_MAX_BYTES, String(diagnosticsBytes(out)));
  assert.equal(out.cut, true);
  assert.equal(Object.hasOwn(out, "firstDoc"), false, "먼저 덜어 내는 것: 불러온 직후 쪽 모양");
  assert.deepEqual(out.ms, { verified: 1, nav: 0, load: 600000 });
  assert.equal(out.load.completeAt.length <= 6, true);
  assert.equal(out.tries.length, 4);
  assert.equal(out.retry.skip, undefined, "모르는 모양의 말은 싣지 않는다");
  assert.equal(JSON.stringify(out).includes("비밀"), false);
  assert.equal(manualDiagnostics({ page: { diagnostics: out } }) !== null, true, "덜어 낸 진단도 서버 검사 통과");
  // 글자 다듬기
  assert.equal(diagnosticText("a\u0000b\n\nc\t d"), "a b c d");
  assert.equal(diagnosticText("\ud800x"), "�x");
  assert.equal(diagnosticText("see https://www.coupang.com/np/search?q=x#y and http://a.b/c?d"), "see https://www.coupang.com/np/search and http://a.b/c");
  assert.equal(Array.from(diagnosticText("가".repeat(300))).length, 200);
  // 크기가 작으면 그대로(cut 없음), 실패면 쪽 모양 둘 다
  const small = buildDiagnostics({ ...input, tries: [{ kind: "no_result" }], doc: { ...doc, title: "t", bodyHead: "b" }, firstDoc: { ...doc, title: "t0", bodyHead: "b0" }, unexpected: null });
  assert.equal(small.cut, undefined);
  assert.equal(small.doc.title, "t");
  assert.equal(small.firstDoc.title, "t0");
  assert.equal(small.hidden, true);
  // 성공: 경과·load 횟수·재시도 여부만
  const ok = buildDiagnostics({ version: "1.0.1", page: { status: "ok", errorCode: null }, ms: { end: 12 }, load: { how: "complete", loading: 1, complete: 1 }, retry: { tried: false }, doc, tries: [{ kind: "ok" }] });
  assert.deepEqual(ok, { v: 1, ext: "1.0.1", ok: true, code: null, ms: { end: 12 }, load: { how: "complete", loading: 1, complete: 1, urls: 0, completeAt: [] }, retry: { tried: false } });
  // 아무것도 못 덜어 내면 최소 모양
  const tiny = buildDiagnostics({ version: "1.0.1", page: { status: "error", errorCode: "extract_failed" }, ms: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`k${index}`, index])) });
  assert.deepEqual(tiny, { v: 1, ext: "1.0.1", ok: false, code: "extract_failed", cut: true });
});

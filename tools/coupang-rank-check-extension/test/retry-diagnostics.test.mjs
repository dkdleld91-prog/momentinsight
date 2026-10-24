// 1.0.1(대표 승인 2026-10-24): 쪽이 스스로 다시 불러오면 한 번 더 읽기 + 어느 길로 끝나든 실패 진단(page.diagnostics).
// 가짜 chrome·가짜 서버만 쓴다(쿠팡·운영 서버 요청 0). 새로고침은 가짜 탭의 loading → complete 사건으로 흉내 낸다.
import assert from "node:assert/strict";
import test from "node:test";
import { createBackground } from "../background.js";
import { buildDiagnostics, diagnosticText, diagnosticsBytes, diagnosticsNodes } from "../lib/assemble.js";
import { DIAGNOSTICS_MAX_BYTES, DIAGNOSTICS_NODES_MAX, EXTENSION_VERSION, searchUrl } from "../lib/protocol.js";
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
  const ok = buildDiagnostics({ version: "1.0.1", page: { status: "ok", errorCode: null }, ms: { end: 12 }, load: { how: "complete", loading: 1, complete: 1 }, retry: { tried: false }, doc, tries: [{ kind: "ok" }], seen: { httpStatus: 429, blockedText: false } });
  assert.deepEqual(ok, { v: 1, ext: "1.0.1", ok: true, code: null, ms: { end: 12 }, load: { how: "complete", loading: 1, complete: 1, urls: 0, completeAt: [] }, retry: { tried: false } });
  // 실패면 불러오는 동안·짧은 읽기에서 본 HTTP 상태·차단 문구·마지막으로 읽은 문서의 HTTP(seen)를 싣는다(모르는 값은 null)
  assert.deepEqual(small.seen, undefined, "seen 을 주지 않으면 없음");
  const seen = buildDiagnostics({ ...input, seen: { httpStatus: 429, blockedText: true, lastHttpStatus: 200 } });
  assert.deepEqual(seen.seen, { http: 429, blocked: true, last: 200 });
  assert.deepEqual(buildDiagnostics({ ...input, seen: { httpStatus: "x" } }).seen, { http: null, blocked: false, last: null });
  // 경과 이름은 16개까지(확장이 남기는 이름은 15개까지) — 서버 값 개수 상한(120) 안에 머문다
  const many = buildDiagnostics({ version: "1.0.1", page: { status: "error", errorCode: "extract_failed" }, ms: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`k${index}`, index])) });
  assert.equal(Object.keys(many.ms).length, 16);
  assert.ok(diagnosticsNodes(many) <= DIAGNOSTICS_NODES_MAX);
  assert.equal(manualDiagnostics({ page: { diagnostics: many } }) !== null, true);
});

test("1.0.1 검토 반영: 진단 글자는 C1 제어 문자·양방향 재정렬·폭 없는 글자를 지우고, scheme 없는 주소·;경로 매개변수·사용자 정보·data: 도 정리한다", () => {
  // C1(U+0085 NEL·U+009B CSI) = 공백, 서식 문자(U+202E·U+2066·U+200B·U+FEFF·U+00AD) = 없앰, 줄 구분(U+2028) = 공백
  assert.equal(diagnosticText("a\u0085b\u009bc\u202ed\u2066e\u200bf\ufeffg\u00adh\u2028i"), "a b cdefgh i");
  const codePoints = (text) => Array.from(text).map((char) => char.codePointAt(0));
  for (const point of codePoints(diagnosticText("x\u0080\u009f\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u2060\u200c\u200d\u061cy"))) {
    assert.ok(point >= 0x20 && point !== 0x7f && !(point >= 0x80 && point <= 0x9f) && !(point >= 0x200b && point <= 0x200f), point.toString(16));
  }
  assert.equal(diagnosticText("see www.coupang.com/np/search?q=SECRETKW&traceId=SECRET2 now"), "see www.coupang.com/np/search now");
  assert.equal(diagnosticText("www.coupang.com?q=SECRET"), "www.coupang.com");
  assert.equal(diagnosticText("final /np/search?q=SECRET#x"), "final /np/search");
  assert.equal(diagnosticText("url https://www.coupang.com/np/search;jsessionid=SECRET3?q=1"), "url https://www.coupang.com/np/search");
  assert.equal(diagnosticText("https://user:SECRET6@www.coupang.com/a?b=1"), "https://www.coupang.com/a");
  assert.equal(diagnosticText("img data:text/html;base64,SECRET5=="), "img data:text/html");
  assert.equal(diagnosticText("rtnUrl=https%3A%2F%2Fwww.coupang.com%2Fnp%2Fsearch%3Fq%3DSECRET8"), "rtnUrl=https%3A%2F%2Fwww.coupang.com%2Fnp%2Fsearch");
  assert.equal(diagnosticText("주소https://www.coupang.com/np/search?q=SECRET7"), "주소https://www.coupang.com/np/search");
  assert.equal(diagnosticText('Cannot access contents of url "https://login.coupang.com/login/login.pang?rtnUrl=x&token=SECRET".'), 'Cannot access contents of url "https://login.coupang.com/login/login.pang".');
  // 주소가 아닌 글은 그대로(물음표·쉼표 포함)
  assert.equal(diagnosticText("찾으시는 상품이 없나요? 1,000원 TypeError: x is null"), "찾으시는 상품이 없나요? 1,000원 TypeError: x is null");
  assert.equal(diagnosticText("chrome-extension://abc/lib/measure.js:12:5"), "chrome-extension://abc/lib/measure.js:12:5");
  // 정리한 글은 서버 진단 검사를 통과한다
  const diag = buildDiagnostics({ version: "1.0.1", page: { status: "error", errorCode: "extract_failed" }, unexpected: "x\u009b[31m\u202ey\u200b", tries: [{ kind: "rejected", msg: "a\u0085b https://x.y/z?SECRET" }], doc: { title: "t\u2066i", bodyHead: "b\u2028h" } });
  assert.notEqual(manualDiagnostics({ page: { diagnostics: diag } }), null);
  assert.equal(JSON.stringify(diag).includes("SECRET"), false);
});

// ── 1.0.1 검토 반영(2026-10-24): 1번 더 읽기 사이 주소 바뀜·본 차단 신호·120초 상한 ──

// 차단 HTTP 를 보이는 probe: 탭이 다시 불러오는 중이면 429(중간 문서), 다 불러왔으면 200.
const probe429WhileLoading = ({ tab }) => (tab.status === "loading"
  ? { readyState: "loading", host: "www.coupang.com", path: "/np/search", httpStatus: 429, blockedText: false }
  : { readyState: "complete", host: "www.coupang.com", path: "/np/search", httpStatus: 200, blockedText: false });

test("1번 더 읽기 사이(첫 측정 뒤 기다리는 동안) 주소가 같은 q 의 다른 쪽(page=2)으로 바뀌면 두 번째 측정 없이 user_navigated(바뀐 이름 page)", async () => {
  let count = 0;
  const { fake, background } = setup({
    chrome: {
      scenario: {
        measure: ({ tab, chrome: fakeRef }) => {
          count += 1;
          if (count > 1) return rawPage();
          // 측정 중엔 주소 없는 다시 불러오기만, 측정이 끝난 뒤(기다리는 동안) 주소가 &page=2 로 바뀌고 complete
          tab.status = "loading";
          fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading" });
          setTimeout(() => {
            tab.url = `${tab.url}&page=2`;
            fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading", url: tab.url });
            setTimeout(() => { tab.status = "complete"; fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "complete" }); }, 10);
          }, 10);
          return undefined;
        },
      },
    },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "user_navigated", "1.0.0 과 같은 판정(순위 기록 없음)");
  assert.deepEqual(reply.page.changedParams, ["page"]);
  assert.equal(reply.page.organic.length, 0);
  assert.equal(measures(fake), 1, "바뀐 주소에서는 측정(스크롤)하지 않는다");
  assert.equal(fake.calls.update.length, 1);
  assert.deepEqual(reply.page.diagnostics.retry, { tried: true, load: "complete", result: "address_changed" });
  assertServerAccepts(reply);
});

test("1번 더 읽기 직전(짧은 읽기 뒤) 주소가 정렬만 바뀌어도 두 번째 쪽 함수를 넣지 않는다 — 두 번째 측정은 첫 측정 기준을 그대로 쓴다", async () => {
  let quicks = 0;
  const { fake, background } = setup({
    chrome: {
      scenario: {
        measure: () => undefined,
        quick: ({ tab, chrome: fakeRef }) => {
          quicks += 1;
          if (quicks === 2) {
            // 1번 더 읽기 전 짧은 읽기 도중 사람이 정렬을 바꿈(탭은 이미 다 불러온 상태)
            tab.url = `${tab.url}&sorter=saleCountDesc`;
            fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading", url: tab.url });
          }
          return rawPage({ items: [], stable: false, scrolls: 0, reads: 1 });
        },
      },
    },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "user_navigated");
  assert.deepEqual(reply.page.changedParams, ["sorter"]);
  assert.equal(measures(fake), 1);
  assert.deepEqual(reply.page.diagnostics.retry, { tried: true, load: "already", result: "address_changed" });
  assert.equal(fake.calls.update.length, 1);
});

test("1번 더 읽기 전 기다리는 동안 load 확인이 본 차단 HTTP(429)면 두 번째 측정(스크롤) 없이 그날 중지 — 뒤 문서가 200 이어도", async () => {
  for (const second of ["ok", "extractError"]) {
    let count = 0;
    const { fake, fetchImpl, background } = setup({
      chrome: {
        scenario: {
          measure: ({ tab, chrome: fakeRef }) => {
            count += 1;
            if (count === 1) {
              selfReload(fakeRef, tab, 60);
              return undefined;
            }
            return second === "ok" ? rawPage() : { extractError: true, host: "www.coupang.com", path: "/np/search", query: "", items: [], httpStatus: 200, error: "x" };
          },
          probe: probe429WhileLoading,
        },
      },
    });
    const reply = await send(background, checkMessage());
    assert.equal(reply.stopSignal, true, second);
    assert.equal(reply.stopReason, "blocked_http_429", second);
    assert.equal(reply.page.httpStatus, 429, second);
    assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["blocked_http_429"], second);
    assert.equal(measures(fake), 1, `${second}: 두 번째 측정 없음`);
    assert.equal(fake.calls.update.length, 1, second);
    assert.ok(fake.storage.blockedDay, second);
    const diag = reply.page.diagnostics;
    assert.deepEqual(diag.retry, { tried: true, load: "complete", result: "blocked" }, second);
    assert.deepEqual(diag.seen, { http: 429, blocked: false, last: 200 }, `${second}: 본 차단 HTTP 와 마지막 문서의 HTTP 가 진단에 함께 남는다`);
    assertServerAccepts(reply);
  }
});

test("첫 load 중 본 429 + 측정이 쪽 안 예외(extractError, 200): 1번 더 읽기를 '차단'으로 건너뛰면 결과도 그날 중지(진단·결과가 맞음)", async () => {
  const { fake, fetchImpl, background } = setup({
    chrome: {
      scenario: {
        loadDelayMs: 60,
        measure: () => ({ extractError: true, host: "www.coupang.com", path: "/np/search", query: "", items: [], httpStatus: 200, error: "x" }),
        probe: probe429WhileLoading,
      },
    },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "extract_failed");
  assert.equal(reply.page.httpStatus, 429);
  assert.equal(reply.stopReason, "blocked_http_429");
  assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["blocked_http_429"]);
  assert.deepEqual(reply.page.diagnostics.retry, { tried: false, skip: "blocked" });
  assert.deepEqual(reply.page.diagnostics.tries, [{ kind: "extract_error", msg: "x" }]);
  assert.equal(measures(fake), 1);
  assertServerAccepts(reply);
  // 1.0.0 규칙 그대로: 첫 load 중 429 를 봤어도 측정이 목록을 다 읽었으면(뒤 문서 200) ok·중지 없음
  const fine = setup({ chrome: { scenario: { loadDelayMs: 60, probe: probe429WhileLoading } } });
  const okReply = await send(fine.background, checkMessage());
  assert.equal(okReply.page.status, "ok");
  assert.equal(okReply.stopSignal, false);
  assert.deepEqual(fine.fetchImpl.stops(), []);
});

test("120초 상한이 1번 더 읽기 전 짧은 읽기 중에 걸리면 두 번째 쪽 함수(스크롤)를 넣지 않는다 — browser_hard_cap·창 닫음", async () => {
  let quicks = 0;
  const { fake, background } = setup({
    chrome: {
      scenario: {
        measure: () => undefined,
        quick: () => {
          quicks += 1;
          if (quicks === 2) return sleep(150).then(() => null); // 상한(80ms)을 넘겨 끝남(짧은 읽기 상한 200ms 안)
          return rawPage({ items: [], stable: false, scrolls: 0, reads: 1 });
        },
      },
    },
    timing: { hardCapMs: 80, quickReadTimeoutMs: 200 },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "browser_hard_cap");
  assert.equal(measures(fake), 1, "상한 뒤에는 측정 함수를 넣지 않는다");
  assert.equal(fake.calls.remove.length, 1);
  assert.equal(fake.windows.size, 0);
  assert.equal(fake.calls.update.length, 1);
});

test("1번 더 읽기 사이 같은 주소 다시 불러오기(주소 없는 loading·같은 주소 url 사건)는 바뀜이 아니다 — 두 번째 측정 ok", async () => {
  let count = 0;
  const { fake, background } = setup({
    chrome: {
      scenario: {
        measure: ({ tab, chrome: fakeRef }) => {
          count += 1;
          if (count > 1) return rawPage();
          tab.status = "loading";
          fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading" });
          setTimeout(() => {
            fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading" });
            fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading", url: tab.url });
            setTimeout(() => { tab.status = "complete"; fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "complete" }); }, 10);
          }, 10);
          return undefined;
        },
      },
    },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.status, "ok");
  assert.equal(measures(fake), 2);
  assert.deepEqual(reply.page.diagnostics.retry, { tried: true, load: "complete", result: "measured" });
  assert.equal(fake.calls.update.length, 1);
});

// ── 1.0.1 재검사 반영(2026-10-24): 기다리는 사이 바뀐 쪽의 차단·최종 문서 HTTP·사용자 정보 ──

const quickReads = (fake) => fake.calls.executeScript.filter((call) => call.func === "miCoupangMeasure" && call.args?.[0]?.quick === true).length;
const blockedRawAt = (tab, { httpStatus = 403, blockedText = true } = {}) => ({
  host: "www.coupang.com", path: new URL(tab.url).pathname, query: "", items: [], httpStatus, blockedText,
  noResultText: false, loginWall: false, stable: false, navigated: false, wasHidden: false,
});
const loadingProbe = () => ({ readyState: "loading", host: "www.coupang.com", path: "/np/search", httpStatus: 200, blockedText: false });

// 첫 측정은 결과 없음(측정 중 loading) → 기다리는 사이 주소가 move(url) 로 바뀜(주소 사건) → 40ms 뒤 complete.
function moveWhileWaiting(move, marks) {
  let count = 0;
  return ({ tab, chrome: fakeRef }) => {
    count += 1;
    if (count > 1) return rawPage();
    tab.status = "loading";
    fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading" });
    setTimeout(() => {
      const next = move(tab.url);
      tab.url = next.url;
      marks.moved = true;
      fakeRef.events.tabsOnUpdated.emit(tab.id, next.urlEvent === false ? { status: "loading" } : { status: "loading", url: tab.url });
      setTimeout(() => { tab.status = "complete"; fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "complete" }); }, 40);
    }, 40);
    return undefined;
  };
}

test("1.0.1 재검사: 1번 더 읽기를 기다리는 사이 주소가 바뀌어 다시 읽지 않아도, 바뀐 쪽이 쿠팡 주소면 짧은 읽기 1번으로 차단을 본다 — 차단 화면이면 그날 중지", async () => {
  const shapes = [
    ["같은 경로에 값이 붙음", (url) => ({ url: `${url}&captcha=1` })],
    ["같은 호스트의 다른 경로", () => ({ url: "https://www.coupang.com/np/blocked" })],
  ];
  const signals = [
    ["HTTP 403 + 차단 문구", { httpStatus: 403, blockedText: true }, "blocked_http_403"],
    ["HTTP 200 + 차단 문구", { httpStatus: 200, blockedText: true }, "blocked_text"],
    ["HTTP 429 만", { httpStatus: 429, blockedText: false }, "blocked_http_429"],
  ];
  for (const [shape, move] of shapes) {
    for (const [signal, values, reason] of signals) {
      const label = `${shape}·${signal}`;
      const marks = { moved: false };
      const { fake, fetchImpl, background } = setup({
        chrome: {
          scenario: {
            measure: moveWhileWaiting(move, marks),
            quick: ({ tab }) => (marks.moved ? blockedRawAt(tab, values) : rawPage({ items: [], stable: false, scrolls: 0, reads: 1 })),
            probe: loadingProbe,
          },
        },
      });
      const reply = await send(background, checkMessage());
      assert.equal(reply.stopSignal, true, label);
      assert.equal(reply.stopReason, reason, label);
      assert.equal(reply.page.status, "blocked", label);
      assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), [reason], label);
      assert.ok(fake.storage.blockedDay, label);
      assert.equal(measures(fake), 1, `${label}: 바뀐 주소에서는 측정(스크롤)하지 않는다`);
      assert.equal(quickReads(fake), 2, `${label}: 불러온 직후 1번 + 바뀐 쪽 1번`);
      assert.equal(fake.calls.update.length, 1, `${label}: 쿠팡 주소 넣기는 1번뿐`);
      const diag = reply.page.diagnostics;
      assert.deepEqual(diag.retry, { tried: true, load: "complete", result: "address_changed" }, label);
      assert.ok(Number.isInteger(diag.ms.movedQuick), label);
      assertServerAccepts(reply);
    }
  }
});

test("1.0.1 재검사: 기다리는 사이 바뀐 쪽이 차단이 아니면 지금처럼 user_navigated·중지 없음(1.0.0 과 같은 판정), 권한 밖으로 바뀌면 짧은 읽기 없이 page_unreadable", async () => {
  // 쿠팡 주소(같은 경로에 값이 붙음): 짧은 읽기 1번은 하지만 차단 신호가 없으니 user_navigated(바뀐 이름 captcha)
  {
    const marks = { moved: false };
    const { fake, fetchImpl, background } = setup({
      chrome: { scenario: { measure: moveWhileWaiting((url) => ({ url: `${url}&captcha=1` }), marks), probe: loadingProbe } },
    });
    const reply = await send(background, checkMessage());
    assert.equal(reply.page.errorCode, "user_navigated");
    assert.deepEqual(reply.page.changedParams, ["captcha"]);
    assert.equal(reply.stopSignal, false);
    assert.deepEqual(fetchImpl.stops(), []);
    assert.equal(measures(fake), 1);
    assert.equal(quickReads(fake), 2);
    assert.equal(fake.calls.update.length, 1);
    assert.deepEqual(reply.page.diagnostics.retry, { tried: true, load: "complete", result: "address_changed" });
    assertServerAccepts(reply);
  }
  // 권한 밖(로그인 화면 — 크롬은 주소를 보여 주지 않음): 읽을 수 없으니 짧은 읽기를 넣지 않고, 지금처럼 탭 주소로 page_unreadable(그날 중지)
  {
    const marks = { moved: false };
    const { fake, fetchImpl, background } = setup({
      chrome: { scenario: { measure: moveWhileWaiting(() => ({ url: LOGIN_URL, urlEvent: false }), marks), probe: loadingProbe } },
    });
    const reply = await send(background, checkMessage());
    assert.equal(reply.page.errorCode, "page_unreadable");
    assert.equal(reply.stopReason, "page_unreadable");
    assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["page_unreadable"]);
    assert.equal(measures(fake), 1);
    assert.equal(quickReads(fake), 1, "권한 밖에는 짧은 읽기를 넣지 않는다");
    assert.equal(fake.calls.update.length, 1);
    assert.deepEqual(reply.page.diagnostics.retry, { tried: true, load: "complete", result: "not_search" });
    assertServerAccepts(reply);
  }
});

test("1.0.1 재검사: 1번 더 읽기 직전(짧은 읽기 뒤) 주소가 바뀌어 두 번째 측정을 하지 않을 때도, 바뀐 쪽 짧은 읽기 1번으로 차단을 보면 그날 중지", async () => {
  let quicks = 0;
  const { fake, fetchImpl, background } = setup({
    chrome: {
      scenario: {
        measure: () => undefined,
        quick: ({ tab, chrome: fakeRef }) => {
          quicks += 1;
          if (quicks === 2) {
            // 다시 읽기 전 짧은 읽기 도중 주소가 같은 호스트의 차단 화면으로 바뀜(탭은 이미 다 불러온 상태)
            tab.url = "https://www.coupang.com/np/blocked";
            fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading", url: tab.url });
            return rawPage({ items: [], stable: false, scrolls: 0, reads: 1 });
          }
          if (quicks >= 3) return blockedRawAt(tab);
          return rawPage({ items: [], stable: false, scrolls: 0, reads: 1 });
        },
      },
    },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.stopReason, "blocked_http_403");
  assert.equal(reply.page.status, "blocked");
  assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["blocked_http_403"]);
  assert.equal(measures(fake), 1, "두 번째 쪽 함수(스크롤)는 넣지 않는다");
  assert.equal(quickReads(fake), 3, "불러온 직후·다시 읽기 전·바뀐 쪽 각 1번");
  assert.equal(fake.calls.update.length, 1);
  assert.deepEqual(reply.page.diagnostics.retry, { tried: true, load: "already", result: "address_changed" });
  assertServerAccepts(reply);
});

test("1.0.1 재검사: 쪽 안 예외 결과는 본 차단 HTTP 를 우선해 그날 중지하고, 진단에는 본 차단 HTTP(seen.http)와 최종 문서의 HTTP(seen.last)를 둘 다 남긴다", async () => {
  const extractError = (httpStatus) => ({
    extractError: true, host: "www.coupang.com", path: "/np/search", query: "", items: [], httpStatus, error: "TypeError",
    doc: { nav: "reload", ready: "complete", title: "쿠팡", bodyLen: 100, bodyHead: "본문", units: 0, links: 0, blocked: false, hidden: false },
  });
  // 중간 문서만 429(첫 load 중 확인), 최종 문서는 200
  {
    const { fake, fetchImpl, background } = setup({
      chrome: { scenario: { loadDelayMs: 60, measure: () => extractError(200), probe: probe429WhileLoading } },
    });
    const reply = await send(background, checkMessage());
    assert.equal(reply.page.errorCode, "extract_failed");
    assert.equal(reply.page.httpStatus, 429, "결과 HTTP 는 차단 쪽 우선(안전)");
    assert.equal(reply.stopReason, "blocked_http_429");
    assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["blocked_http_429"]);
    assert.deepEqual(reply.page.diagnostics.seen, { http: 429, blocked: false, last: 200 }, "중간 문서 429·최종 문서 200");
    assert.equal(fake.calls.update.length, 1);
    assertServerAccepts(reply);
  }
  // 최종 문서 자신이 429(불러오는 동안은 200)
  {
    const { fake, background } = setup({
      chrome: {
        scenario: {
          loadDelayMs: 60,
          measure: () => extractError(429),
          probe: ({ tab }) => ({ readyState: tab.status === "loading" ? "loading" : "complete", host: "www.coupang.com", path: "/np/search", httpStatus: 200, blockedText: false }),
        },
      },
    });
    const reply = await send(background, checkMessage());
    assert.equal(reply.page.httpStatus, 429);
    assert.equal(reply.stopReason, "blocked_http_429");
    assert.deepEqual(reply.page.diagnostics.seen, { http: 200, blocked: false, last: 429 }, "최종 문서 429 — 위 경우와 진단으로 가려진다");
    assert.equal(fake.calls.update.length, 1);
    assertServerAccepts(reply);
  }
});

test("1.0.1 재검사 4차: 상한(2000자)에서 잘린 끝 낱말은 버린다 — 'user:SECRET@' 가운데가 잘려도 비밀 앞부분이 남지 않는다", () => {
  const url = "https://user:SECRET@www.coupang.com/a";
  for (const pad of [" ".repeat(1985), "\u200b".repeat(1985), "\u0001".repeat(1990), "가 ".repeat(993)]) {
    const out = diagnosticText(pad + url);
    assert.equal(/SECRET|SE$|user:/u.test(out), false, JSON.stringify(out));
  }
  // 상한보다 짧으면 지금처럼 끝까지 다듬는다
  assert.equal(diagnosticText(" ".repeat(100) + url), "https://www.coupang.com/a");
});

test("1.0.1 재검사 4차: 첫 측정이 쪽 안 예외로 끝나고 기다리는 사이 권한 밖(로그인 화면)으로 보내지면 page_unreadable·그날 중지", async () => {
  const marks = { moved: false };
  let count = 0;
  const measure = ({ tab, chrome: fakeRef }) => {
    count += 1;
    if (count > 1) return rawPage();
    tab.status = "loading";
    fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading" });
    setTimeout(() => {
      tab.url = LOGIN_URL;
      marks.moved = true;
      fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading" });
      setTimeout(() => { tab.status = "complete"; fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "complete" }); }, 40);
    }, 40);
    return { extractError: true, host: "www.coupang.com", path: "/np/search", query: "", items: [], httpStatus: 200, error: "TypeError" };
  };
  const { fake, fetchImpl, background } = setup({ chrome: { scenario: { measure, probe: loadingProbe } } });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "page_unreadable");
  assert.equal(reply.stopReason, "page_unreadable");
  assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["page_unreadable"]);
  assert.equal(measures(fake), 1, "권한 밖에서는 다시 측정하지 않는다");
  assert.equal(fake.calls.update.length, 1, "쿠팡 주소 넣기는 1번뿐");
  assertServerAccepts(reply);
});

test("1.0.1 재검사: 진단 주소는 어떤 모양이든 호스트·경로만 — scheme 없음·// 시작·인코딩·따옴표·; 가 든 사용자 정보도 지우고 @·%40 이 남지 않는다", () => {
  const cases = [
    ["user:SECRET@www.coupang.com/a", "www.coupang.com/a"],
    ["//user:SECRET@www.coupang.com/np/search?q=S", "//www.coupang.com/np/search"],
    ["https://user:SECRET@www.coupang.com/a?b=1", "https://www.coupang.com/a"],
    ["HTTPS://USER:SECRET@WWW.COUPANG.COM/np", "HTTPS://WWW.COUPANG.COM/np"],
    ["user:SECRET@www.coupang.com", "www.coupang.com"],
    ["user%3ASECRET%40www.coupang.com/a", "www.coupang.com/a"],
    ["https%3A%2F%2Fuser%3ASECRET%40www.coupang.com%2Fa", "www.coupang.com%2Fa"],
    ["https://user;x:SECRET@www.coupang.com/a;jsessionid=SECRET?q=SECRET#SECRET", "https://www.coupang.com/a"],
    ["https://user:p%40SECRET@www.coupang.com/a", "https://www.coupang.com/a"],
    ['https://user:p"SECRET@www.coupang.com/a', "https://www.coupang.com/a"],
    ["a@b@www.coupang.com/x", "www.coupang.com/x"],
    ['url "//user:SECRET@www.coupang.com/x?y".', 'url "//www.coupang.com/x".'],
    ["rtnUrl=https://user:SECRET@x.y/z?q", "rtnUrl=https://x.y/z"],
    // 인코딩된 쿼리 안의 %40 은 덩어리가 %3F 에서 멈추지 않아 앞 주소까지 지워진다(더 지우는 쪽, 1.0.1 재검사 4차)
    ["rtnUrl=https%3A%2F%2Fwww.coupang.com%2Fnp%2Fsearch%3Fq%3DSECRET%40y", "y"],
    // 크롬은 사용자 정보의 ?·# 를 %3F·%23 으로 쓴다 — 비밀번호 앞부분도 남지 않는다(1.0.1 재검사 4차)
    ["https://alice:pa%3FSECRET%23word@www.coupang.com/np/search?q=abc", "https://www.coupang.com/np/search"],
    ["https://us%3FSECRET:pw@www.coupang.com/a", "https://www.coupang.com/a"],
    ['Cannot access contents of url "https://alice:pa%3FSECRET%23w@www.coupang.com/np/search?q=abc". x', 'Cannot access contents of url "https://www.coupang.com/np/search". x'],
    ["www.coupang.com/a?x=SECRET@y#z", "www.coupang.com/a"],
    ["문의 SECRET@coupang.com", "문의 coupang.com"],
  ];
  for (const [input, expected] of cases) {
    const out = diagnosticText(input);
    assert.equal(out, expected, input);
    assert.equal(/SECRET|@|%40/i.test(out), false, input);
  }
  // 무작위 글(주소 조각·인코딩·따옴표·제어 문자를 섞음): 다듬은 글에는 @·%40 이 없고 서버 검사를 통과한다
  const parts = ["a", "b", ":", "@", "%40", "%3F", "%23", "/", "?", "#", " ", '"', ";", "%", "4", "0", "3", "f", "\u0000", "www.coupang.com", "//", "https://"];
  let seed = 7;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let round = 0; round < 3000; round += 1) {
    let text = "";
    const length = 1 + Math.floor(next() * 16);
    for (let index = 0; index < length; index += 1) text += parts[Math.floor(next() * parts.length)];
    const out = diagnosticText(text);
    assert.equal(/@|%40/i.test(out), false, JSON.stringify(text));
    assert.notEqual(manualDiagnostics({ diagnostics: { v: 1, ext: EXTENSION_VERSION, unexpected: out } }), null, JSON.stringify(text));
  }
  // 아주 긴 글(크롬 오류 문구 안의 긴 주소 등)도 빨리 끝나고 200자 상한 그대로
  const started = Date.now();
  // 상한(2000자)을 넘는 한 낱말은 잘린 끝 낱말이라 버린다(1.0.1 재검사 4차) — 200자 상한 안, 비밀 조각 없음
  assert.ok(Array.from(diagnosticText(`https://${"a.".repeat(500000)}`)).length <= 200);
  assert.equal(Array.from(diagnosticText("word ".repeat(100000))).length, 200, "낱말 사이가 있으면 200자 상한 그대로");
  assert.equal(diagnosticText("@".repeat(100000)), "");
  assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
  // 실행 전체(진단 tries): 넣지 못한 오류 문구 속 사용자 정보도 지워져 서버에 닿는다
  const diag = buildDiagnostics({
    version: EXTENSION_VERSION, page: { status: "error", errorCode: "extract_failed" },
    tries: [{ kind: "rejected", msg: 'Cannot access "//user:SECRET@www.coupang.com/np/search?q=S" and user:SECRET@www.coupang.com/a' }],
  });
  assert.equal(diag.tries[0].msg, 'Cannot access "//www.coupang.com/np/search" and www.coupang.com/a');
  assert.notEqual(manualDiagnostics({ page: { diagnostics: diag } }), null);
});

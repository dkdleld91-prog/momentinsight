// 쪽 안 함수(miCoupangMeasure·miCoupangProbe)를 node:vm 의 가짜 DOM 에서 돌린다. 기다림은 0 으로 둔다.
// 새 vm 문맥에는 DOM 비슷한 값만 넣으므로, 함수가 이 파일 밖 값을 쓰면 ReferenceError 로 드러난다(자기완결 확인).
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { miCoupangMeasure, miCoupangProbe } from "../lib/measure.js";
import { splitItems } from "../lib/assemble.js";
import { LIST_PARAM_DEFAULTS, sameListParams, searchAddressOf } from "../lib/protocol.js";
import { EXTRACT_SOURCE, parseExtractResult, splitItems as collectorSplitItems } from "../../coupang-rank-collector/lib/extract.mjs";
import { fixture } from "./helpers.mjs";

const ZERO = { settleMs: 0, scrollCount: 8, extraScrollCount: 2, scrollPixels: 1400, gapMin: 0, gapMax: 0, readGapMs: 0 };
const BLOCK_BODY = "쿠팡!\n요청하신 페이지의 사용권한이 없습니다.\n사용권한이 제한된 페이지입니다. 고객센터로 문의해 주세요.";
const FORBIDDEN_METHODS = ["click", "focus", "blur", "dispatchEvent", "submit", "requestSubmit", "setAttribute", "remove"];

function itemsFromFixture(name) {
  return fixture(name).items.map((item) => ({
    href: `https://www.coupang.com/vp/products/${item.p}?itemId=1&vendorItemId=${item.v}${item.ad ? "&sourceType=srp_product_ads" : "&sourceType=search"}`,
    text: `${item.t}\n가격 12,000원\n무료배송`,
  }));
}

function makeDom({
  host = "www.coupang.com",
  pathname = "/np/search",
  search = `?q=${encodeURIComponent("아이폰 케이스")}&channel=user`,
  bodyText = "검색 결과\n로그인하고 더 많은 상품을 확인하세요",
  title = "아이폰 케이스 - 쿠팡!",
  items = itemsFromFixture("page-full.json"),
  itemsAtRead = null,
  httpStatus = 200,
  visibility = "visible",
  onScroll = null,
} = {}) {
  const forbidden = [];
  const scrolls = [];
  const listeners = new Map();
  const guard = (target) => new Proxy(target, {
    get(object, key) {
      if (FORBIDDEN_METHODS.includes(key)) return () => forbidden.push(String(key));
      return object[key];
    },
    set(object, key, value) {
      forbidden.push(`set:${String(key)}`);
      object[key] = value;
      return true;
    },
  });
  let readIndex = 0;
  const li = ({ href, text }) => guard({
    innerText: text,
    querySelector: (selector) => (selector === 'a[href*="/vp/products/"]' && href ? guard({ href }) : null),
  });
  const location = guard({ host, pathname, search, href: `https://${host}${pathname}${search}` });
  const document = guard({
    readyState: "complete",
    visibilityState: visibility,
    title,
    body: guard({ innerText: bodyText }),
    querySelectorAll(selector) {
      if (selector !== 'li[class*="ProductUnit"]') return [];
      readIndex += 1;
      const list = itemsAtRead ? itemsAtRead(readIndex) : items;
      return list.map(li);
    },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  });
  const dom = { forbidden, scrolls, listeners, location, document, setVisibility: null };
  const window = guard({
    scrollBy(x, y) {
      scrolls.push([x, y]);
      if (onScroll) onScroll(dom, scrolls.length);
    },
  });
  const performance = { getEntriesByType: (type) => (type === "navigation" ? [{ responseStatus: httpStatus }] : []) };
  dom.setVisibility = (value) => {
    Reflect.set(document, "visibilityState", value);
    forbidden.pop(); // 테스트가 바꾼 값은 금지 기록에서 뺀다
    const fn = listeners.get("visibilitychange");
    if (fn) fn();
  };
  dom.context = vm.createContext({ document, location, window, performance, URL, URLSearchParams, setTimeout });
  return dom;
}

async function run(dom, options = ZERO) {
  const fn = vm.runInContext(`(${miCoupangMeasure.toString()})`, dom.context);
  const result = await fn(options);
  return JSON.parse(JSON.stringify(result));
}

test("자기완결: 새 문맥(DOM 값만)에서 돌고, 화면을 누르거나 값을 바꾸지 않는다", async () => {
  const dom = makeDom();
  const result = await run(dom);
  assert.equal(result.extractError, undefined);
  assert.deepEqual(dom.forbidden, []);
  assert.equal(dom.listeners.size, 0, "visibilitychange 리스너는 끝나면 뗀다");
  const probe = vm.runInContext(`(${miCoupangProbe.toString()})`, dom.context)();
  assert.deepEqual(JSON.parse(JSON.stringify(probe)), { readyState: "complete", host: "www.coupang.com", path: "/np/search", httpStatus: 200, blockedText: false });
  assert.deepEqual(dom.forbidden, [], "load 확인도 화면을 바꾸지 않는다");
});

test("load 확인(probe)도 불러오는 동안의 차단 신호(HTTP 403·429·503·한국어 차단 문구)를 적는다 — 첫 읽기 전에 창이 닫혀도 남게", () => {
  const probeOf = (dom) => JSON.parse(JSON.stringify(vm.runInContext(`(${miCoupangProbe.toString()})`, dom.context)()));
  for (const httpStatus of [403, 429, 503]) assert.equal(probeOf(makeDom({ httpStatus, items: [] })).httpStatus, httpStatus);
  assert.equal(probeOf(makeDom({ bodyText: BLOCK_BODY, title: "쿠팡!", items: [] })).blockedText, true);
  assert.equal(probeOf(makeDom({ title: "Access Denied", bodyText: "", items: [] })).blockedText, true);
  assert.equal(probeOf(makeDom({ httpStatus: 0 })).httpStatus, null);
});

test("쿠팡이 불러온 뒤 주소 꼬리(추적 값)만 바꾸면 사람의 이동이 아니다(navigated=false), q 가 바뀌면 이동", async () => {
  const tail = makeDom({
    onScroll: (state, count) => {
      if (count === 2) {
        Reflect.set(state.location, "search", `${state.location.search}&traceId=abc&channel=user`);
        state.forbidden.pop();
      }
    },
  });
  const kept = await run(tail);
  assert.equal(kept.navigated, false);
  assert.equal(kept.scrolls, 8);
  assert.equal(kept.stable, true);
  const other = makeDom({
    onScroll: (state, count) => {
      if (count === 2) {
        Reflect.set(state.location, "search", `?q=${encodeURIComponent("다른 검색어")}`);
        state.forbidden.pop();
      }
    },
  });
  const moved = await run(other);
  assert.equal(moved.navigated, true);
  assert.equal(moved.stable, false);
});

// 2026-10-23 재검사 r6: 같은 쪽 안 이동(pushState)으로 정렬·쪽 번호가 바뀌고 목록이 바뀌어도 이동으로 보지 않아 바뀐 목록이 ok 였다.
// 목록의 순서·범위를 바꾸는 값(sorter·page·listSize)은 경로·q 와 함께 본다. 쿠팡 기본값(1쪽·랭킹순)과 추적 꼬리는 이동이 아니다.
// 확장 쪽(background isSearchAddress = protocol listParamsOf·sameListParams)과 판정이 같아야 한다.
const LIST_CASES = [
  ["&sorter=saleCountDesc", true],
  ["&sorter=salePriceAsc&channel=user", true],
  ["&page=2", true],
  ["&listSize=72", true],
  ["&listSize=36", true],
  ["&page=1", false],
  ["&sorter=scoreDesc", false],
  ["&page=1&sorter=scoreDesc&traceId=abc&channel=recent", false],
  ["&page=&sorter=", false],
];

test("측정 중 정렬·쪽 번호·목록 크기가 바뀌면 이동(navigated, stable 아님), 기본값·추적 꼬리만이면 이동 아님 — 확장 판정과 같다", async () => {
  const base = `?q=${encodeURIComponent("아이폰 케이스")}&channel=user`;
  for (const [tail, expected] of LIST_CASES) {
    const dom = makeDom({
      search: base,
      onScroll: (state, count) => {
        if (count === 2) {
          Reflect.set(state.location, "search", `${state.location.search}${tail}`);
          state.forbidden.pop();
        }
      },
    });
    const result = await run(dom);
    assert.equal(result.navigated, expected, tail);
    if (expected) assert.equal(result.stable, false, tail);
    const start = searchAddressOf(`https://www.coupang.com/np/search${base}`);
    const end = searchAddressOf(`https://www.coupang.com/np/search${base}${tail}`);
    assert.equal(!sameListParams(start.list, end.list), expected, `확장 판정 ${tail}`);
  }
  // 측정 시작 때 이미 붙어 있던 값은 기준이다(쿠팡이 불러오는 동안 붙였어도 그 뒤 바뀜만 본다)
  const already = makeDom({
    search: `${base}&listSize=36&page=1`,
    onScroll: (state, count) => {
      if (count === 2) {
        Reflect.set(state.location, "search", `${state.location.search}&traceId=x`);
        state.forbidden.pop();
      }
    },
  });
  assert.equal((await run(already)).navigated, false);
});

test("쪽 함수의 목록 값 기본값 표 = lib/protocol.js LIST_PARAM_DEFAULTS(쪽 함수는 자기완결이라 import 못 함)", () => {
  const source = miCoupangMeasure.toString();
  const literal = source.match(/const listDefaults = (\{[^}]*\});/);
  assert.ok(literal, "쪽 함수 안에 listDefaults 표가 있다");
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInNewContext(`(${literal[1]})`))), { ...LIST_PARAM_DEFAULTS });
});

test("정상 검색 1쪽: 스크롤 8번(1400px)·읽기 3번·stable·검색어·HTTP 상태·광고 표식·제목 첫 줄", async () => {
  const dom = makeDom();
  const result = await run(dom);
  assert.equal(result.scrolls, 8);
  assert.deepEqual(dom.scrolls, Array.from({ length: 8 }, () => [0, 1400]));
  assert.equal(result.reads, 3);
  assert.equal(result.stable, true);
  assert.equal(result.navigated, false);
  assert.equal(result.query, "아이폰 케이스");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.blockedText, false);
  assert.equal(result.loginWall, true);
  assert.equal(result.host, "www.coupang.com");
  assert.equal(result.path, "/np/search");
  assert.equal(result.items.length, 60);
  assert.equal(result.items.filter((item) => item.ad).length, 10);
  assert.equal(result.items[0].t, fixture("page-full.json").items[0].t);
  assert.match(result.items[0].p, /^\d+$/);
  assert.match(result.items[0].v, /^\d+$/);
});

test("차단 화면(HTTP 200 + '사용권한이 없습니다'·'사용권한이 제한된') → blockedText, 스크롤 0", async () => {
  for (const bodyText of [BLOCK_BODY, "사용권한이 제한된 페이지입니다", "Access Denied - You don't have permission to access"]) {
    const dom = makeDom({ bodyText, title: "쿠팡!", items: [] });
    const result = await run(dom);
    assert.equal(result.blockedText, true, bodyText);
    assert.equal(result.scrolls, 0);
    assert.equal(result.reads, 1);
    assert.equal(result.stable, false);
  }
  const titled = await run(makeDom({ title: "Access Denied", bodyText: "", items: [] }));
  assert.equal(titled.blockedText, true);
});

test("HTTP 403·429·503 이면 문구가 없어도 스크롤하지 않는다", async () => {
  for (const httpStatus of [403, 429, 503]) {
    const dom = makeDom({ httpStatus });
    const result = await run(dom);
    assert.equal(result.httpStatus, httpStatus);
    assert.equal(result.scrolls, 0);
  }
});

test("쿠팡 검색 1쪽이 아니면 스크롤하지 않는다", async () => {
  const dom = makeDom({ pathname: "/np/campaigns/82", search: "" });
  const result = await run(dom);
  assert.equal(result.scrolls, 0);
  assert.equal(result.path, "/np/campaigns/82");
  assert.equal(result.stable, false);
});

test("개수 흔들림: 2번 더 스크롤해 다시 읽고, 같으면 stable·다르면 stable=false", async () => {
  const all = itemsFromFixture("page-full.json");
  const settles = makeDom({ itemsAtRead: (index) => (index === 2 ? all.slice(0, 50) : all.slice(0, 55)) });
  const first = await run(settles);
  assert.equal(first.scrolls, 10);
  assert.equal(first.reads, 4);
  assert.equal(first.stable, true);
  assert.equal(first.items.length, 55);
  const keeps = makeDom({ itemsAtRead: (index) => all.slice(0, [0, 40, 50, 55, 60][index] ?? 60) });
  const second = await run(keeps);
  assert.equal(second.scrolls, 10);
  assert.equal(second.stable, false);
  assert.equal(second.items.length, 60);
});

test("측정 중 주소가 바뀌면(사람이 창을 누름) 멈추고 navigated", async () => {
  const dom = makeDom({
    onScroll: (state, count) => {
      if (count === 3) {
        Reflect.set(state.location, "pathname", "/vp/products/123456");
        state.forbidden.pop();
      }
    },
  });
  const result = await run(dom);
  assert.equal(result.navigated, true);
  assert.equal(result.scrolls, 3);
  assert.equal(result.stable, false);
});

test("측정 중 한 번이라도 숨으면 wasHidden(판정은 서버가 한다)", async () => {
  const hiddenAtStart = await run(makeDom({ visibility: "hidden" }));
  assert.equal(hiddenAtStart.wasHidden, true);
  const dom = makeDom({
    onScroll: (state, count) => {
      if (count === 2) state.setVisibility("hidden");
      if (count === 4) state.setVisibility("visible");
    },
  });
  const result = await run(dom);
  assert.equal(result.wasHidden, true);
  assert.equal(result.visibility, "visible");
  assert.equal(result.stable, true, "stable 은 개수 비교 그대로 둔다");
});

test("quick: 기다리지 않고 한 번만 읽는다(스크롤 0)", async () => {
  const dom = makeDom({ httpStatus: 403 });
  const started = Date.now();
  const result = await run(dom, { ...ZERO, settleMs: 10_000, quick: true });
  assert.ok(Date.now() - started < 2000);
  assert.equal(result.reads, 1);
  assert.equal(result.scrolls, 0);
  assert.equal(result.httpStatus, 403);
});

test("검색어 q 는 100 코드 포인트·제어 문자는 공백, HTTP 상태가 이상하면 null", async () => {
  const long = "가".repeat(130);
  const result = await run(makeDom({ search: `?q=${encodeURIComponent(`${long}\u0001`)}`, httpStatus: 0 }));
  assert.equal(Array.from(result.query).length, 100);
  assert.equal(result.httpStatus, null);
});

test("수집기 읽기 함수(EXTRACT_SOURCE)와 같은 DOM 에서 같은 목록·같은 나누기 결과", async () => {
  for (const name of ["page-full.json", "page-short.json"]) {
    const dom = makeDom({ items: itemsFromFixture(name) });
    const collectorRaw = parseExtractResult(vm.runInContext(EXTRACT_SOURCE, dom.context));
    const ours = await run(makeDom({ items: itemsFromFixture(name) }), { ...ZERO, quick: true });
    assert.deepEqual(ours.items, JSON.parse(JSON.stringify(collectorRaw.items)), name);
    assert.deepEqual(splitItems(ours), JSON.parse(JSON.stringify(collectorSplitItems(collectorRaw))), name);
    assert.equal(ours.host, collectorRaw.host);
    assert.equal(ours.path, collectorRaw.path);
    assert.equal(ours.loginWall, collectorRaw.loginWall);
    assert.equal(ours.noResultText, collectorRaw.noResultText);
  }
  // 영어 차단 문구는 둘 다 잡고, 한국어 차단 문구는 확장만 잡는다(수집기 보강은 자동 재개 묶음에서).
  const english = makeDom({ bodyText: "Access Denied", items: [] });
  assert.equal(parseExtractResult(vm.runInContext(EXTRACT_SOURCE, english.context)).blockedText, true);
  const korean = makeDom({ bodyText: BLOCK_BODY, items: [] });
  assert.equal(parseExtractResult(vm.runInContext(EXTRACT_SOURCE, korean.context)).blockedText, false);
  assert.equal((await run(makeDom({ bodyText: BLOCK_BODY, items: [] }))).blockedText, true);
});

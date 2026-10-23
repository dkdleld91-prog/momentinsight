// 쪽 안 함수(miCoupangMeasure·miCoupangProbe)를 node:vm 의 가짜 DOM 에서 돌린다. 기다림은 0 으로 둔다.
// 새 vm 문맥에는 DOM 비슷한 값만 넣으므로, 함수가 이 파일 밖 값을 쓰면 ReferenceError 로 드러난다(자기완결 확인).
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { miCoupangMeasure, miCoupangProbe } from "../lib/measure.js";
import { splitItems } from "../lib/assemble.js";
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
  assert.deepEqual(JSON.parse(JSON.stringify(probe)), { readyState: "complete", host: "www.coupang.com", path: "/np/search" });
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

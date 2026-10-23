// 수집기(자동 경로)와 같은 규칙인지: 시간 상수·검색 주소·광고 표식·읽기 선택자·차단 문구·나누기 결과·제목 다듬기.
// 수집기 파일은 읽기만 한다(tools/coupang-rank-collector 무접촉).
import assert from "node:assert/strict";
import test from "node:test";
import * as collect from "../../coupang-rank-collector/lib/collect.mjs";
import * as collectorContract from "../../coupang-rank-collector/lib/contract.mjs";
import { EXTRACT_SOURCE, parseExtractResult, splitItems as collectorSplitItems } from "../../coupang-rank-collector/lib/extract.mjs";
import * as protocol from "../lib/protocol.js";
import * as assemble from "../lib/assemble.js";
import { DEFAULT_MEASURE_OPTIONS, DEFAULT_TIMING } from "../background.js";
import { fixture, readExtension } from "./helpers.mjs";

const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xde00);
const SMILE = String.fromCodePoint(0x1f600);

test("시간 상수 = 수집기 collect.mjs·계약(45초·120초·2.5초·8번·2번·1400px·350~700ms·1.2초)", () => {
  assert.equal(protocol.SETTLE_MS, collect.SETTLE_MS);
  assert.equal(protocol.SCROLL_COUNT, collect.SCROLL_COUNT);
  assert.equal(protocol.EXTRA_SCROLL_COUNT, collect.EXTRA_SCROLL_COUNT);
  assert.equal(protocol.SCROLL_PIXELS, collect.SCROLL_PIXELS);
  assert.deepEqual([...protocol.SCROLL_GAP_MS], [...collect.SCROLL_GAP_MS]);
  assert.equal(protocol.READ_GAP_MS, collect.READ_GAP_MS);
  assert.equal(protocol.LOAD_TIMEOUT_MS, collectorContract.NAV_TIMEOUT_MS);
  assert.equal(protocol.HARD_CAP_MS, collectorContract.BROWSER_HARD_CAP_SECONDS * 1000);
  assert.equal(DEFAULT_TIMING.loadTimeoutMs, collectorContract.NAV_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMING.hardCapMs, collectorContract.BROWSER_HARD_CAP_SECONDS * 1000);
  assert.deepEqual(DEFAULT_MEASURE_OPTIONS, {
    settleMs: collect.SETTLE_MS,
    scrollCount: collect.SCROLL_COUNT,
    extraScrollCount: collect.EXTRA_SCROLL_COUNT,
    scrollPixels: collect.SCROLL_PIXELS,
    gapMin: collect.SCROLL_GAP_MS[0],
    gapMax: collect.SCROLL_GAP_MS[1],
    readGapMs: collect.READ_GAP_MS,
  });
  // 쪽 함수의 기본값도 같다(옵션이 빠져도 수집기 범위를 넘지 않게).
  const measure = readExtension("lib/measure.js");
  for (const [name, value] of [["settleMs", 2500], ["scrollCount", 8], ["extraScrollCount", 2], ["scrollPixels", 1400], ["gapMin", 350], ["gapMax", 700], ["readGapMs", 1200]]) {
    assert.ok(measure.includes(`num(o.${name}, ${value})`), name);
  }
  assert.equal(protocol.KEEPALIVE_MS, 15000);
  // 서버 확인 + 창 120초 + 짧은 읽기 + 창 닫기 + 중지 알림 = 확장이 답하기까지 최대 시간(150초 안).
  const worst = protocol.SERVER_TIMEOUT_MS + protocol.HARD_CAP_MS + protocol.QUICK_READ_TIMEOUT_MS + protocol.CLOSE_TIMEOUT_MS + protocol.SERVER_TIMEOUT_MS;
  assert.ok(worst < 150000, `확장 최대 ${worst}ms`);
});

test("검색 주소·광고 표식·차단 HTTP 상태·개수 상한 = 수집기 계약", () => {
  for (const keyword of ["아이폰 케이스", "a&b=c", "100% 면", "  공백  ", "😀 이모지", "#해시"]) {
    assert.equal(protocol.searchUrl(keyword), collectorContract.coupangSearchUrl(keyword), keyword);
  }
  assert.equal(protocol.SEARCH_URL_PREFIX, collectorContract.coupangSearchUrl(""));
  assert.equal(protocol.AD_SOURCE_TYPE, collectorContract.AD_SOURCE_TYPE);
  assert.deepEqual([...protocol.BLOCKED_HTTP_STATUSES], [...collectorContract.BLOCKED_HTTP_STATUSES]);
  assert.equal(assemble.ORGANIC_MAX, collectorContract.ORGANIC_MAX);
  assert.equal(assemble.ADS_MAX, collectorContract.ADS_MAX);
  assert.equal(assemble.SLOT_MAX, collectorContract.SLOT_MAX);
  assert.equal(assemble.TITLE_MAX, collectorContract.TITLE_MAX);
  assert.equal(protocol.SERVER_ORIGIN, collectorContract.PUBLIC_ORIGIN);
  for (const code of protocol.PAGE_ERROR_CODES) assert.match(code, collectorContract.COLLECTOR_ERROR_CODE_PATTERN);
  for (const code of protocol.NOT_STARTED_CODES) assert.match(code, collectorContract.COLLECTOR_ERROR_CODE_PATTERN);
});

test("읽기 규칙: 수집기 EXTRACT_SOURCE 의 선택자·광고 표식·제목 200자·차단 문구 5개·결과 없음·로그인 문구가 쪽 함수에 모두 있다 + 한국어 차단 문구", () => {
  const measure = readExtension("lib/measure.js");
  for (const piece of [
    'li[class*="ProductUnit"]',
    'a[href*="/vp/products/"]',
    `=== "${collectorContract.AD_SOURCE_TYPE}"`,
    'searchParams.get("vendorItemId")',
    'searchParams.get("sourceType")',
    ".slice(0, 200)",
    ".slice(0, 4000)",
    "Access Denied|permission to access|비정상적인 접근|자동입력 방지|captcha",
    "검색결과가 없습니다",
    "로그인하고 더 많은 상품",
    "/Access Denied/i.test(",
  ]) {
    assert.ok(EXTRACT_SOURCE.includes(piece) || piece === "/Access Denied/i.test(", `수집기에 ${piece}`);
    assert.ok(measure.includes(piece), `쪽 함수에 ${piece}`);
  }
  assert.ok(measure.includes("사용권한이 없습니다"));
  assert.ok(measure.includes("사용권한이 제한된"));
});

test("나누기: 수집기 고정본 3개에서 splitItems 결과가 수집기와 같다", () => {
  for (const name of ["page-full.json", "page-short.json", "page-no-result.json"]) {
    const raw = fixture(name);
    assert.deepEqual(assemble.splitItems(raw), collectorSplitItems(parseExtractResult(JSON.stringify(raw))), name);
  }
});

test("나누기: 경계값(201번째·광고 31개·일반 101개·잘못된 상품번호·숫자 p·홀로 남은 서러게이트 제목)도 수집기와 같다", () => {
  const items = [];
  for (let index = 0; index < 230; index += 1) {
    const ad = index % 3 === 0;
    items.push({
      p: index === 5 ? "12" : index === 6 ? 12345678 : String(10000000 + index),
      v: index === 7 ? "abc" : index === 8 ? "123456789012345678901" : String(70000000000 + index),
      ad,
      t: index === 9 ? `${LONE_HIGH}제목` : index === 10 ? `${"가".repeat(90)}` : index === 11 ? `  ${SMILE}  ` : index === 12 ? "" : `상품 ${index}${LONE_LOW}`,
    });
  }
  const raw = { host: "www.coupang.com", path: "/np/search", items };
  assert.deepEqual(assemble.splitItems(raw), collectorSplitItems(parseExtractResult(JSON.stringify(raw))));
  for (const value of ["", "  ", "abc", `${LONE_HIGH}x`, `x${LONE_LOW}`, "가".repeat(100), `${SMILE}`.repeat(81), `${LONE_HIGH}${LONE_LOW}`, null, undefined, 123]) {
    assert.equal(assemble.clipTitle(value), collectorContract.clipTitle(value), JSON.stringify(value));
  }
});

test("assemblePage: 성공·차단·실패 모양(실패는 목록을 비우고 차단 신호·주소는 남긴다 — 수집기 P2)", () => {
  const ok = assemble.assemblePage({ ...fixture("page-full.json"), httpStatus: 200, stable: true, query: "q" });
  assert.equal(ok.status, "ok");
  assert.equal(ok.errorCode, null);
  assert.equal(ok.organic.length, 50);
  const blocked = assemble.assemblePage({ host: "www.coupang.com", path: "/np/search", httpStatus: 403, items: [], stable: false });
  assert.equal(blocked.status, "blocked");
  assert.equal(assemble.isStopSignal(blocked), true);
  const timeout = assemble.assemblePage({ host: "www.coupang.com", path: "/np/search?x#y", httpStatus: 403, items: fixture("page-full.json").items }, { errorCode: "page_timeout" });
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.httpStatus, 403);
  assert.equal(timeout.organic.length, 0);
  assert.equal(timeout.finalPath, "/np/search");
  assert.equal(timeout.stable, false);
  assert.equal(assemble.isStopSignal(timeout), true);
  const unreadable = assemble.assemblePage({}, { errorCode: "page_unreadable" });
  assert.equal(unreadable.status, "error");
  assert.equal(assemble.isStopSignal(unreadable), true, "D1");
  for (const code of ["window_closed", "page_load_failed", "user_navigated", "browser_hard_cap", "extract_failed"]) {
    assert.equal(assemble.isStopSignal(assemble.assemblePage({ host: "www.coupang.com", path: "/np/search" }, { errorCode: code })), false, code);
  }
  const adsOnly = assemble.assemblePage({ host: "www.coupang.com", path: "/np/search", httpStatus: 200, stable: true, items: fixture("page-full.json").items.filter((item) => item.ad) });
  assert.equal(adsOnly.organic.length, 0);
  assert.equal(assemble.isStopSignal(adsOnly), false, "광고만 있고 일반 0개 = empty(차단 아님)");
  const empty = assemble.assemblePage({ host: "www.coupang.com", path: "/np/search", httpStatus: 200, stable: true, items: [] });
  assert.equal(assemble.isStopSignal(empty), false);
  const login = assemble.assemblePage({ host: "login.coupang.com", path: "/login/login.pang", httpStatus: 200, items: [] });
  assert.equal(assemble.isStopSignal(login), true);
  const weird = assemble.assemblePage({ host: "WWW.COUPANG.COM", path: "/np/search\u0001", httpStatus: 999, query: `a\u0000b${"c".repeat(200)}`, extractError: true });
  assert.equal(weird.finalHost, "www.coupang.com");
  assert.equal(weird.finalPath, "");
  assert.equal(weird.httpStatus, null);
  assert.equal(weird.errorCode, "extract_failed");
  assert.equal(Array.from(weird.query).length, 100);
  assert.ok(!/[\u0000-\u001f]/.test(weird.query));
});

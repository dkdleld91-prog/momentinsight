import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCollectorPage,
  recordPayloadForRpc,
  sanitizeTitles,
  validateCollectorRecord,
} from "./page-result.mjs";
import { ADS_MAX, ORGANIC_MAX, TITLE_MAX, WORKER_BODY_MAX_BYTES } from "./contract.mjs";

const RUN_ID = "2cd1a0b4-9e1f-4c55-8a2b-0f6c3d9e7a10";

function page(overrides = {}) {
  return {
    status: "ok",
    httpStatus: 200,
    loginWall: true,
    stable: true,
    noResultText: false,
    blockedText: false,
    itemCount: 60,
    organic: [
      { p: "9000001", v: "", s: 3 },
      { p: "8533720933", v: "96009802650", s: 38, t: "아이쉘 360도 액정보호 풀커버" },
    ],
    ads: [{ p: "8533720933", v: "96009802650", s: 22, t: "아이쉘 360도 액정보호 풀커버" }],
    finalHost: "www.coupang.com",
    finalPath: "/np/search",
    errorCode: null,
    ...overrides,
  };
}

function record(overrides = {}, pageOverrides = {}) {
  return {
    action: "record",
    runId: RUN_ID,
    keywordKey: "아이폰 18프로 사생활 보호 필름",
    page: page(pageOverrides),
    durationMs: 14833,
    collectorVersion: "1.0.0",
    browser: "edge 141.0.3537.71",
    ...overrides,
  };
}

function items(count, { startSlot = 1, title } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const item = { p: String(10000 + index), v: String(index), s: startSlot + index };
    if (title !== undefined) item.t = title;
    return item;
  });
}

function expectField(body, field) {
  assert.deepEqual(validateCollectorRecord(body), { ok: false, field });
}

test("명세 예시 record 는 검증을 통과한다", () => {
  assert.deepEqual(validateCollectorRecord(record()), { ok: true });
});

test("최상위 칸 경계값: runId·keywordKey·durationMs·collectorVersion·browser", () => {
  expectField(null, "body");
  expectField([], "body");
  expectField(record({ runId: "not-a-uuid" }), "runId");
  expectField(record({ runId: 12 }), "runId");
  assert.equal(validateCollectorRecord(record({ runId: RUN_ID.toUpperCase() })).ok, true);
  expectField(record({ keywordKey: "" }), "keywordKey");
  expectField(record({ keywordKey: 3 }), "keywordKey");
  assert.equal(validateCollectorRecord(record({ keywordKey: "가".repeat(50) })).ok, true);
  expectField(record({ keywordKey: "가".repeat(51) }), "keywordKey");
  // 코드 포인트 기준: 이모지 50개는 UTF-16 100단위지만 50자로 센다(SQL char_length 와 같음)
  assert.equal(validateCollectorRecord(record({ keywordKey: "😀".repeat(50) })).ok, true);
  expectField(record({ durationMs: -1 }), "durationMs");
  expectField(record({ durationMs: 600001 }), "durationMs");
  expectField(record({ durationMs: 1.5 }), "durationMs");
  assert.equal(validateCollectorRecord(record({ durationMs: 0 })).ok, true);
  assert.equal(validateCollectorRecord(record({ durationMs: 600000 })).ok, true);
  expectField(record({ collectorVersion: "1.0" }), "collectorVersion");
  expectField(record({ collectorVersion: "v1.0.0" }), "collectorVersion");
  expectField(record({ browser: "e".repeat(61) }), "browser");
  expectField(record({ browser: null }), "browser");
  assert.equal(validateCollectorRecord(record({ browser: "e".repeat(60) })).ok, true);
  assert.equal(validateCollectorRecord(record({ browser: "" })).ok, true);
});

test("page 칸 경계값: status·httpStatus·불리언·itemCount", () => {
  expectField(record({ page: null }), "page");
  expectField(record({ page: [] }), "page");
  expectField(record({}, { status: "found" }), "page.status");
  expectField(record({}, { status: "OK" }), "page.status");
  for (const status of ["ok", "blocked", "timeout", "error"]) {
    assert.equal(validateCollectorRecord(record({}, { status })).ok, true, status);
  }
  expectField(record({}, { httpStatus: -1 }), "page.httpStatus");
  expectField(record({}, { httpStatus: 600 }), "page.httpStatus");
  expectField(record({}, { httpStatus: 200.5 }), "page.httpStatus");
  expectField(record({}, { httpStatus: "200" }), "page.httpStatus");
  assert.equal(validateCollectorRecord(record({}, { httpStatus: null })).ok, true);
  assert.equal(validateCollectorRecord(record({}, { httpStatus: 0 })).ok, true);
  assert.equal(validateCollectorRecord(record({}, { httpStatus: 599 })).ok, true);
  // JSON 에서 빠진 httpStatus·errorCode 는 null 로 본다(수집기가 undefined 를 넣으면 키가 사라짐)
  const missing = record();
  delete missing.page.httpStatus;
  delete missing.page.errorCode;
  assert.equal(validateCollectorRecord(missing).ok, true);
  for (const flag of ["loginWall", "stable", "noResultText", "blockedText"]) {
    expectField(record({}, { [flag]: "true" }), `page.${flag}`);
    expectField(record({}, { [flag]: null }), `page.${flag}`);
  }
  expectField(record({}, { itemCount: -1 }), "page.itemCount");
  expectField(record({}, { itemCount: 201 }), "page.itemCount");
  expectField(record({}, { itemCount: "60" }), "page.itemCount");
  assert.equal(validateCollectorRecord(record({}, { itemCount: 0 })).ok, true);
  assert.equal(validateCollectorRecord(record({}, { itemCount: 200 })).ok, true);
});

test("목록 상한: organic 100·ads 30", () => {
  assert.equal(validateCollectorRecord(record({}, { organic: items(ORGANIC_MAX), ads: [] })).ok, true);
  expectField(record({}, { organic: items(ORGANIC_MAX + 1), ads: [] }), "page.organic");
  assert.equal(validateCollectorRecord(record({}, { organic: [], ads: items(ADS_MAX) })).ok, true);
  expectField(record({}, { organic: [], ads: items(ADS_MAX + 1) }), "page.ads");
  expectField(record({}, { organic: null }), "page.organic");
  expectField(record({}, { ads: {} }), "page.ads");
});

test("목록 원소: p·v·s 형식과 여분 키", () => {
  const one = (item) => record({}, { organic: [item], ads: [] });
  expectField(one({ p: "123", v: "", s: 1 }), "page.organic[0].p");
  assert.equal(validateCollectorRecord(one({ p: "1234", v: "", s: 1 })).ok, true);
  assert.equal(validateCollectorRecord(one({ p: "1".repeat(15), v: "", s: 1 })).ok, true);
  expectField(one({ p: "1".repeat(16), v: "", s: 1 }), "page.organic[0].p");
  expectField(one({ p: "12a45", v: "", s: 1 }), "page.organic[0].p");
  expectField(one({ p: 12345, v: "", s: 1 }), "page.organic[0].p");
  assert.equal(validateCollectorRecord(one({ p: "12345", v: "1".repeat(20), s: 1 })).ok, true);
  expectField(one({ p: "12345", v: "1".repeat(21), s: 1 }), "page.organic[0].v");
  expectField(one({ p: "12345", v: "x1", s: 1 }), "page.organic[0].v");
  expectField(one({ p: "12345", s: 1 }), "page.organic[0].v");
  expectField(one({ p: "12345", v: "", s: 0 }), "page.organic[0].s");
  expectField(one({ p: "12345", v: "", s: 201 }), "page.organic[0].s");
  expectField(one({ p: "12345", v: "", s: 1.5 }), "page.organic[0].s");
  expectField(one({ p: "12345", v: "", s: "1" }), "page.organic[0].s");
  assert.equal(validateCollectorRecord(one({ p: "12345", v: "", s: 200 })).ok, true);
  expectField(one({ p: "12345", v: "", s: 1, ad: true }), "page.organic[0].ad");
  expectField(one({ p: "12345", v: "", s: 1, t: 7 }), "page.organic[0].t");
  expectField(one({ p: "12345", v: "", s: 1, t: null }), "page.organic[0].t");
  expectField(record({}, { organic: [null], ads: [] }), "page.organic[0]");
  expectField(record({}, { organic: [["12345"]], ads: [] }), "page.organic[0]");
});

test("s 순서와 중복: 배열 안 오름차순, 두 배열 사이 중복 금지", () => {
  expectField(record({}, {
    organic: [{ p: "11111", v: "", s: 5 }, { p: "22222", v: "", s: 4 }], ads: [],
  }), "page.organic[1].s");
  expectField(record({}, {
    organic: [{ p: "11111", v: "", s: 5 }, { p: "22222", v: "", s: 5 }], ads: [],
  }), "page.organic[1].s");
  expectField(record({}, {
    organic: [{ p: "11111", v: "", s: 5 }], ads: [{ p: "22222", v: "", s: 5 }],
  }), "page.ads[0].s");
  // 광고가 일반 사이에 끼어 있어도(s 가 섞여도) 배열마다 오름차순이면 통과
  assert.equal(validateCollectorRecord(record({}, {
    organic: [{ p: "11111", v: "", s: 1 }, { p: "33333", v: "", s: 3 }],
    ads: [{ p: "22222", v: "", s: 2 }, { p: "44444", v: "", s: 4 }],
  })).ok, true);
  // 같은 상품번호가 두 번 나와도(옵션 다름) 거절하지 않는다
  assert.equal(validateCollectorRecord(record({}, {
    organic: [{ p: "11111", v: "1", s: 1 }, { p: "11111", v: "2", s: 2 }], ads: [],
  })).ok, true);
});

test("finalHost·finalPath·errorCode 형식", () => {
  expectField(record({}, { finalHost: "WWW.COUPANG.COM" }), "page.finalHost");
  expectField(record({}, { finalHost: "a".repeat(61) }), "page.finalHost");
  expectField(record({}, { finalHost: null }), "page.finalHost");
  expectField(record({}, { finalHost: "www.coupang.com\n" }), "page.finalHost");
  assert.equal(validateCollectorRecord(record({}, { finalHost: "" })).ok, true);
  assert.equal(validateCollectorRecord(record({}, { finalHost: "a".repeat(60) })).ok, true);
  expectField(record({}, { finalPath: "/np/search?q=1" }), "page.finalPath");
  expectField(record({}, { finalPath: "/np/search#top" }), "page.finalPath");
  expectField(record({}, { finalPath: "/".repeat(81) }), "page.finalPath");
  expectField(record({}, { finalPath: undefined }), "page.finalPath");
  assert.equal(validateCollectorRecord(record({}, { finalPath: "" })).ok, true);
  assert.equal(validateCollectorRecord(record({}, { finalPath: "/".repeat(80) })).ok, true);
  expectField(record({}, { errorCode: "Page_Timeout" }), "page.errorCode");
  expectField(record({}, { errorCode: "" }), "page.errorCode");
  expectField(record({}, { errorCode: "a".repeat(61) }), "page.errorCode");
  expectField(record({}, { errorCode: 5 }), "page.errorCode");
  assert.equal(validateCollectorRecord(record({}, { errorCode: "page_timeout" })).ok, true);
  assert.equal(validateCollectorRecord(record({}, { errorCode: "a".repeat(60) })).ok, true);
});

test("제목 다듬기: 홀로 남은 서러게이트·81 코드 포인트·빈 문자열은 t 만 지우고 결과는 받는다", () => {
  const lone = "\uD800깨진 제목";
  const tooLong = "가".repeat(TITLE_MAX + 1);
  const emojiMax = "😀".repeat(TITLE_MAX); // UTF-16 160단위지만 80 코드 포인트라 통과
  const body = record({}, {
    organic: [
      { p: "10001", v: "", s: 1, t: lone },
      { p: "10002", v: "", s: 2, t: tooLong },
      { p: "10003", v: "", s: 3, t: "" },
      { p: "10004", v: "", s: 4, t: "   " },
      { p: "10005", v: "", s: 5, t: emojiMax },
      { p: "10006", v: "7", s: 6, t: "멀쩡한 제목" },
      { p: "10007", v: "", s: 7 },
    ],
    ads: [{ p: "10008", v: "", s: 8, t: "\uDC00" }],
  });
  // 검증은 거절하지 않는다
  assert.deepEqual(validateCollectorRecord(body), { ok: true });
  const before = JSON.stringify(body.page);
  const cleaned = sanitizeTitles(body.page);
  assert.equal(JSON.stringify(body.page), before, "입력을 바꾸지 않는다");
  assert.deepEqual(cleaned.organic, [
    { p: "10001", v: "", s: 1 },
    { p: "10002", v: "", s: 2 },
    { p: "10003", v: "", s: 3 },
    { p: "10004", v: "", s: 4 },
    { p: "10005", v: "", s: 5, t: emojiMax },
    { p: "10006", v: "7", s: 6, t: "멀쩡한 제목" },
    { p: "10007", v: "", s: 7 },
  ]);
  assert.deepEqual(cleaned.ads, [{ p: "10008", v: "", s: 8 }]);
  // 나머지 칸은 그대로라 판정·보고가 이어진다
  assert.equal(cleaned.status, "ok");
  assert.equal(cleaned.itemCount, 60);
  assert.deepEqual(validateCollectorRecord({ ...body, page: cleaned }), { ok: true });
  assert.equal(classifyCollectorPage(cleaned).status, "ok");
  assert.equal(TITLE_MAX, 80);
  assert.equal(Array.from(tooLong).length, 81);
});

function classify(overrides) {
  return classifyCollectorPage(page(overrides));
}

test("판정 표 12행: 각 행이 자기 상태를 낸다", () => {
  const rows = [
    [1, { httpStatus: 403 }, { status: "blocked" }],
    [1, { httpStatus: 429 }, { status: "blocked" }],
    [1, { httpStatus: 503 }, { status: "blocked" }],
    [2, { blockedText: true }, { status: "blocked" }],
    [2, { status: "blocked", httpStatus: 200 }, { status: "blocked" }],
    [3, { finalHost: "login.coupang.com", finalPath: "/login/login.pang" }, { status: "blocked" }],
    [3, { finalHost: "www.coupang.com", finalPath: "/login/login.pang" }, { status: "blocked" }],
    [3, { finalHost: "coupang.com", finalPath: "/login" }, { status: "blocked" }],
    [4, { status: "timeout", httpStatus: null }, { status: "timeout" }],
    [5, { status: "error", httpStatus: null }, { status: "error" }],
    [6, { finalHost: "www.google.com", finalPath: "/" }, { status: "error", errorCode: "foreign_navigation" }],
    [6, { finalHost: "", finalPath: "" }, { status: "error", errorCode: "foreign_navigation" }],
    [7, { httpStatus: 404 }, { status: "error" }],
    [7, { httpStatus: 500 }, { status: "error" }],
    [8, { finalHost: "m.coupang.com" }, { status: "unsupported" }],
    [8, { finalPath: "/vp/products/8533720933" }, { status: "unsupported" }],
    [8, { finalPath: "/np/search/" }, { status: "unsupported" }],
    [9, { organic: [], noResultText: true }, { status: "noresult" }],
    [10, { organic: [] }, { status: "empty" }],
    [11, { stable: false }, { status: "partial" }],
    [12, {}, { status: "ok" }],
  ];
  for (const [row, overrides, expected] of rows) {
    assert.deepEqual(classify(overrides), expected, `행 ${row}: ${JSON.stringify(overrides)}`);
  }
});

test("판정 우선순위: 차단 신호는 수집기의 error·timeout 보다 먼저다(P2)", () => {
  assert.deepEqual(classify({ status: "error", httpStatus: 403, finalHost: "", finalPath: "" }), { status: "blocked" });
  assert.deepEqual(classify({ status: "timeout", httpStatus: 429 }), { status: "blocked" });
  assert.deepEqual(classify({ status: "error", httpStatus: 503, errorCode: "cdp_error" }), { status: "blocked" });
  assert.deepEqual(classify({ status: "timeout", blockedText: true }), { status: "blocked" });
  assert.deepEqual(classify({ status: "error", finalHost: "login.coupang.com", finalPath: "/login/login.pang" }), { status: "blocked" });
  // /login 은 쿠팡 주소일 때만 차단
  assert.deepEqual(classify({ finalHost: "www.example.com", finalPath: "/login" }), { status: "error", errorCode: "foreign_navigation" });
  // 실패로 온 것은 다른 사이트여도 그 실패 그대로(6행보다 4·5행이 먼저)
  assert.deepEqual(classify({ status: "timeout", httpStatus: null, finalHost: "www.google.com" }), { status: "timeout" });
  assert.deepEqual(classify({ status: "error", httpStatus: null, finalHost: "" }), { status: "error" });
  // 쿠팡처럼 보이는 다른 도메인은 쿠팡이 아니다
  for (const host of ["notcoupang.com", "coupang.com.example.net", "coupang.co.kr", "login.coupang.com.evil.io"]) {
    assert.deepEqual(classify({ finalHost: host }), { status: "error", errorCode: "foreign_navigation" }, host);
  }
  // 다른 사이트의 403 도 차단(1행이 가장 먼저)
  assert.deepEqual(classify({ finalHost: "www.google.com", httpStatus: 403 }), { status: "blocked" });
  // 404(1행 아님)는 쿠팡이 아니면 6행, 쿠팡이면 7행
  assert.deepEqual(classify({ finalHost: "www.google.com", httpStatus: 404 }), { status: "error", errorCode: "foreign_navigation" });
  // 7행이 8행보다 먼저: 이동한 쪽의 HTTP 오류는 error
  assert.deepEqual(classify({ finalHost: "m.coupang.com", httpStatus: 410 }), { status: "error" });
  // 9·10행이 11행보다 먼저: 일반 0개면 stable 과 무관
  assert.deepEqual(classify({ organic: [], stable: false }), { status: "empty" });
  assert.deepEqual(classify({ organic: [], stable: false, noResultText: true }), { status: "noresult" });
  // 광고만 있고 일반 0개면 빈 쪽
  assert.deepEqual(classify({ organic: [], ads: [{ p: "11111", v: "", s: 1 }] }), { status: "empty" });
  // 8행이 9행보다 먼저: 검색 쪽이 아니면 결과 없음 문구가 있어도 unsupported
  assert.deepEqual(classify({ finalPath: "/np/categories/1", organic: [], noResultText: true }), { status: "unsupported" });
});

test("recordPayloadForRpc: p_run 칸과 errorCode 덮어쓰기", () => {
  const body = record({}, { errorCode: "extract_failed" });
  const payload = recordPayloadForRpc(body, { status: "ok" });
  assert.deepEqual(Object.keys(payload), [
    "httpStatus", "loginWall", "stable", "itemCount", "organic", "ads",
    "finalHost", "finalPath", "durationMs", "collectorVersion", "browser", "errorCode",
  ]);
  assert.equal(payload.errorCode, "extract_failed");
  assert.equal(payload.httpStatus, 200);
  assert.equal(payload.durationMs, 14833);
  assert.equal(payload.collectorVersion, "1.0.0");
  assert.equal(payload.browser, "edge 141.0.3537.71");
  assert.deepEqual(payload.organic, body.page.organic);
  assert.deepEqual(payload.ads, body.page.ads);
  assert.equal(payload.noResultText, undefined, "p_run 에 없는 칸은 넘기지 않는다");

  const foreign = recordPayloadForRpc(body, { status: "error", errorCode: "foreign_navigation" });
  assert.equal(foreign.errorCode, "foreign_navigation");

  const missing = record();
  delete missing.page.httpStatus;
  delete missing.page.errorCode;
  const filled = recordPayloadForRpc(missing, { status: "ok" });
  assert.equal(filled.httpStatus, null);
  assert.equal(filled.errorCode, null);
});

test("가장 큰 정상 record(일반 100·광고 30, 4바이트 글자 80개 제목)도 본문 상한 64KB 안이다", () => {
  const title = "😀".repeat(TITLE_MAX);
  const body = record({}, {
    itemCount: 200,
    organic: items(ORGANIC_MAX, { startSlot: 1, title }).map((item) => ({ ...item, v: "9".repeat(20), p: "1".repeat(15) })),
    ads: items(ADS_MAX, { startSlot: 101, title }).map((item) => ({ ...item, v: "9".repeat(20), p: "1".repeat(15) })),
  });
  assert.deepEqual(validateCollectorRecord(body), { ok: true });
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  assert.ok(bytes < WORKER_BODY_MAX_BYTES, `bytes=${bytes}`);
});

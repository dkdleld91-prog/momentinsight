// 서비스 워커 동작(가짜 chrome·가짜 서버). 지난 검토 결함 장면을 모두 다시 본다(previous-run review:*).
import assert from "node:assert/strict";
import test from "node:test";
import { createBackground, isSearchAddress, startBackground } from "../background.js";
import { searchUrl } from "../lib/protocol.js";
import {
  ADMIN_SENDER, CHROME_UA, CLAIM_ID, CLAIM_ID_2, CLAIM_ID_3, CLAIM_TOKEN, FAST_TIMING, SERVER_KEYWORD,
  checkMessage, defaultVerify, makeFakeChrome, makeFakeFetch, rawPage, send, sleep,
} from "./helpers.mjs";

const ZERO_MEASURE = { settleMs: 0, gapMin: 0, gapMax: 0, readGapMs: 0 };
const SERVER = "https://insight.momentlabs.co.kr/api/coupang-rank-trackers";
const VERIFY_PREFIX = `${SERVER}?view=manual-verify&claimId=`;
const BLOCKED_403 = () => rawPage({ httpStatus: 403, items: [], blockedText: false, stable: false });

function setup({ chrome: chromeOptions = {}, fetch: handler, now, timing = {}, serverTime } = {}) {
  const fake = makeFakeChrome(chromeOptions);
  const fetchImpl = makeFakeFetch(handler, fake.log, { serverTime });
  const background = createBackground(fake.chrome, {
    fetch: fetchImpl,
    now,
    timing: { ...FAST_TIMING, ...timing },
    measure: ZERO_MEASURE,
    uaText: CHROME_UA,
  });
  return { fake, fetchImpl, background };
}

function noSearch(fake, fetchImpl, { verifies = 0 } = {}) {
  assert.equal(fake.calls.update.length, 0, "쿠팡 주소로 이동 0번");
  assert.equal(fetchImpl.views().filter((view) => view === "manual-verify").length, verifies, "서버 확인 횟수");
}

function clockFrom(start) {
  const clock = { value: start };
  clock.now = () => clock.value;
  return clock;
}

// ── 보낸 쪽·형식 ──

test("보낸 쪽 검사: 다른 출처·같은 출처의 /home·하위 프레임·http 는 origin_rejected(창·서버 요청 0)", async () => {
  const { fake, fetchImpl, background } = setup();
  const senders = [
    { origin: "https://evil.example", url: "https://evil.example/admin", frameId: 0 },
    { origin: "https://insight.momentlabs.co.kr", url: "https://insight.momentlabs.co.kr/home", frameId: 0 },
    { origin: "https://insight.momentlabs.co.kr", url: "https://insight.momentlabs.co.kr/news?x=/admin", frameId: 0 },
    { origin: "https://insight.momentlabs.co.kr", url: "https://insight.momentlabs.co.kr/admin", frameId: 3 },
    { origin: "http://insight.momentlabs.co.kr", url: "http://insight.momentlabs.co.kr/admin", frameId: 0 },
    { url: "https://insight.momentlabs.co.kr.evil.example/admin", frameId: 0 },
    null,
  ];
  for (const sender of senders) {
    let answer;
    const returned = background.listener(checkMessage(), sender, (reply) => { answer = reply; });
    assert.equal(returned, false);
    assert.deepEqual(answer, { ok: false, code: "origin_rejected" });
  }
  assert.equal(fake.calls.create.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
  const ok = await send(background, { type: "mi-coupang-hello" }, { ...ADMIN_SENDER, url: "https://insight.momentlabs.co.kr/admin.html?tab=c30" });
  assert.equal(ok.ok, true);
});

test("형식 검사: 모르는 type·토큰 없음·uuid 아님 → bad_request(창·서버 요청 0)", async () => {
  const { fake, fetchImpl, background } = setup();
  assert.deepEqual(await send(background, { type: "mi-coupang-run-all" }), { ok: false, code: "bad_request" });
  assert.deepEqual(await send(background, "hello"), { ok: false, code: "bad_request" });
  for (const message of [
    checkMessage({ claimToken: undefined }),
    checkMessage({ claimToken: "mcm1_short" }),
    checkMessage({ claimId: "not-a-uuid" }),
    checkMessage({ claimToken: `mic1_${"A".repeat(43)}` }),
  ]) {
    const reply = await send(background, message);
    assert.equal(reply.outcome, "not_started");
    assert.equal(reply.code, "bad_request");
  }
  assert.equal(fake.calls.create.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

// 2026-10-23 재검사 r7: 꾸민 check 마다 서버 확인 전에 빈 시크릿 창이 포커스를 가져가며 열렸다 닫혔다.
// 창을 열기 전에 보낸 쪽·메시지 모양(검색어 포함)을 모두 본다. 어긋나면 창 0개·서버 요청 0번.
test("창을 열기 전 검사: 검색어 없음·빈 값·앞뒤 공백·50자 넘음·제어 문자·문자열 아님 → bad_request, 창 0개", async () => {
  const { fake, fetchImpl, background } = setup();
  for (const keyword of [undefined, null, "", " 아이폰", "아이폰 ", "가".repeat(51), "아이폰\n케이스", "a\u0000b", 42, ["아이폰"], "\ud800"]) {
    const reply = await send(background, checkMessage({ keyword }));
    assert.deepEqual([reply.outcome, reply.code], ["not_started", "bad_request"], JSON.stringify(keyword));
  }
  // r7 그대로: 서버가 준 적 없는 요청 id·모양 맞는 토큰·검색어 없음 10번
  for (let index = 0; index < 10; index += 1) {
    const reply = await send(background, { type: "mi-coupang-check", claimId: CLAIM_ID_2, claimToken: CLAIM_TOKEN });
    assert.equal(reply.code, "bad_request");
  }
  assert.equal(fake.calls.create.length, 0, "창 0개");
  assert.equal(fake.calls.windowsUpdate.length, 0);
  assert.equal(fetchImpl.calls.length, 0, "서버 요청 0번");
  // 50자(코드 포인트) 검색어는 모양이 맞다
  assert.equal((await send(background, checkMessage({ keyword: "가".repeat(50) }))).outcome, "measured");
});

test("창을 열기 전 검사: 보낸 쪽 origin·tab·frameId 가 없거나 다르면 origin_rejected(hello 도), 창 0개", async () => {
  const { fake, fetchImpl, background } = setup();
  const { origin: _origin, ...noOrigin } = ADMIN_SENDER;
  const { tab: _tab, ...noTab } = ADMIN_SENDER;
  const { frameId: _frameId, ...noFrame } = ADMIN_SENDER;
  for (const sender of [
    noOrigin,
    noTab,
    noFrame,
    { ...ADMIN_SENDER, tab: { incognito: false } },
    { ...ADMIN_SENDER, origin: "https://insight.momentlabs.co.kr:8443" },
    { ...ADMIN_SENDER, url: "https://insight.momentlabs.co.kr/admin/x" },
    { ...ADMIN_SENDER, id: "abcdefghijklmnopabcdefghijklmnop", url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/admin", origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
  ]) {
    for (const message of [checkMessage(), { type: "mi-coupang-hello" }]) {
      let answer;
      assert.equal(background.listener(message, sender, (reply) => { answer = reply; }), false);
      assert.deepEqual(answer, { ok: false, code: "origin_rejected" }, JSON.stringify(sender));
    }
  }
  assert.equal(fake.calls.create.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test("서버가 거절한 요청(모양은 맞음)은 빈 창을 포커스 없이 열었다 닫는다: 앞으로 가져오기 0번·쿠팡 이동 0번", async () => {
  const { fake, fetchImpl, background } = setup({ fetch: () => ({ status: 404, body: { ok: false, code: "COUPANG_MANUAL_CLAIM_NOT_FOUND" } }) });
  for (let index = 0; index < 3; index += 1) {
    const reply = await send(background, checkMessage());
    assert.deepEqual([reply.code, reply.serverCode], ["verify_refused", "COUPANG_MANUAL_CLAIM_NOT_FOUND"]);
  }
  assert.deepEqual([...new Set(fake.calls.create.map((call) => call.focused))], [false]);
  assert.equal(fake.calls.windowsUpdate.length, 0, "서버 확인 전·거절 뒤에는 창을 앞으로 가져오지 않는다");
  assert.equal(fake.calls.remove.length, 3);
  assert.equal(fake.windows.size, 0);
  noSearch(fake, fetchImpl, { verifies: 3 });
});

test("창을 앞으로 가져오지 못해도(windows.update 실패) 측정은 그대로 한다", async () => {
  const { fake, background } = setup({ chrome: { focusFails: true } });
  const reply = await send(background, checkMessage());
  assert.equal(reply.outcome, "measured");
  assert.equal(reply.page.status, "ok");
  assert.equal(fake.calls.windowsUpdate.length, 1);
  assert.equal(fake.calls.update.length, 1);
});

// ── hello ──

test("hello: 버전·시크릿 허용·사이트 액세스·다른 시크릿 창·작업 중·브라우저·설치 방식·남은 결과·남은 창", async () => {
  const { background } = setup();
  assert.deepEqual(await send(background, { type: "mi-coupang-hello" }), {
    ok: true,
    type: "hello",
    version: "1.0.0",
    incognitoAllowed: true,
    hostAccess: true,
    incognitoWindowOpen: false,
    busy: false,
    browser: "chrome 141",
    installType: "development",
    pending: null,
    leftover: { closed: 0, unknown: false },
  });
});

test("hello: 시크릿 허용이 꺼져 있으면 다른 시크릿 창을 볼 수 없으므로 incognitoWindowOpen=null, 사이트 액세스 막힘=false", async () => {
  const { background } = setup({ chrome: { incognitoAllowed: false, permissions: false } });
  const reply = await send(background, { type: "mi-coupang-hello" });
  assert.equal(reply.incognitoAllowed, false);
  assert.equal(reply.incognitoWindowOpen, null);
  assert.equal(reply.hostAccess, false);
});

// ── 창을 열기 전에 멈춤(지난 결함: 각각 감지해 창을 열기 전에 멈추고 안내) ──

test("시크릿 허용 꺼짐 → incognito_not_allowed, 서버 확인·창 0", async () => {
  const { fake, fetchImpl, background } = setup({ chrome: { incognitoAllowed: false } });
  const reply = await send(background, checkMessage());
  assert.equal(reply.code, "incognito_not_allowed");
  assert.equal(reply.outcome, "not_started");
  assert.equal(fake.calls.create.length, 0);
  noSearch(fake, fetchImpl);
});

test("사이트 액세스 막힘(클릭 시) → host_access_withheld, 권한 API 가 없거나 실패해도 막힘(모름=열지 않음)", async () => {
  for (const permissions of [false, "missing", "throw"]) {
    const { fake, fetchImpl, background } = setup({ chrome: { permissions } });
    const reply = await send(background, checkMessage());
    assert.equal(reply.code, "host_access_withheld", String(permissions));
    assert.equal(reply.hostAccess, permissions === false ? false : null);
    assert.equal(fake.calls.create.length, 0);
    noSearch(fake, fetchImpl);
  }
  const queries = [];
  const { background } = setup({ chrome: { permissions: (query) => { queries.push(query); return true; } } });
  await send(background, checkMessage());
  assert.deepEqual(queries[0], { origins: ["https://www.coupang.com/*", "https://insight.momentlabs.co.kr/*"] });
});

test("다른 시크릿 창 열림 → incognito_window_open(모든 창 종류를 본다), 목록을 못 읽으면 열림으로 보고 멈춤", async () => {
  const opened = setup({ chrome: { windows: [{ id: 41, incognito: true, type: "popup" }] } });
  assert.equal((await send(opened.background, checkMessage())).code, "incognito_window_open");
  assert.deepEqual(opened.fake.calls.getAll[0], { windowTypes: ["normal", "popup", "panel", "app", "devtools"] });
  assert.equal(opened.fake.calls.create.length, 0);
  noSearch(opened.fake, opened.fetchImpl);

  const fallback = setup({ chrome: { getAllWithTypes: "throw", windows: [{ id: 42, incognito: true }] } });
  assert.equal((await send(fallback.background, checkMessage())).code, "incognito_window_open");
  assert.deepEqual(fallback.fake.calls.getAll, [{ windowTypes: ["normal", "popup", "panel", "app", "devtools"] }, undefined]);

  const unknown = setup({ chrome: { getAllWithTypes: "throw", getAllDefault: "throw" } });
  assert.equal((await send(unknown.background, checkMessage())).code, "incognito_window_open");
  noSearch(unknown.fake, unknown.fetchImpl);
});

test("동시에 check 2개: 작업 중 표시를 await 전에 켜서 창은 1개, 두 번째는 busy", async () => {
  const { fake, background } = setup();
  const [first, second] = await Promise.all([
    send(background, checkMessage()),
    send(background, checkMessage({ claimId: CLAIM_ID_2 })),
  ]);
  assert.equal(first.outcome, "measured");
  assert.equal(second.code, "busy");
  assert.equal(fake.calls.create.length, 1);
});

test("같은 요청 번호로 다시 보내면 서버가 1회용으로 거절(CLAIM_USED → verify_refused), 쿠팡 검색은 1번만(두 번째 빈 창은 닫음)", async () => {
  const clock = clockFrom(1_000_000);
  const { fake, background } = setup({ now: clock.now });
  assert.equal((await send(background, checkMessage())).outcome, "measured");
  clock.value += 200_000;
  const again = await send(background, checkMessage());
  assert.equal(again.code, "verify_refused");
  assert.equal(again.serverCode, "COUPANG_MANUAL_CLAIM_USED");
  assert.equal(fake.calls.update.length, 1, "쿠팡 주소는 첫 번째만");
  assert.equal(fake.calls.create.length, 2);
  assert.equal(fake.windows.size, 0, "거절된 빈 창도 닫는다");
});

test("같은 크롬 안 상대 간격 170초(보조): 안이면 too_soon(서버 확인 0), 맥 시계가 뒤로 가도 막히지 않는다", async () => {
  const clock = clockFrom(5_000_000);
  const { fake, fetchImpl, background } = setup({ now: clock.now });
  assert.equal((await send(background, checkMessage())).outcome, "measured");
  clock.value += 60_000;
  const soon = await send(background, checkMessage({ claimId: CLAIM_ID_2 }));
  assert.equal(soon.code, "too_soon");
  assert.ok(soon.retryAfterSec > 100 && soon.retryAfterSec <= 110, String(soon.retryAfterSec));
  assert.equal(fetchImpl.calls.length, 1);
  clock.value -= 3_600_000; // 시계가 한 시간 뒤로
  assert.equal((await send(background, checkMessage({ claimId: CLAIM_ID_3 }))).outcome, "measured");
  assert.equal(fake.calls.create.length, 2);
});

// ── 서버 확인(지난 결함: 확장이 서버 확인 없이 창을 엶) ──

test("서버 확인: 빈 시크릿 창 검사 뒤·쿠팡 주소를 넣기 전에 GET manual-verify 1번, 토큰은 머리글(주소에 없음)·세션 쿠키 포함·리다이렉트 안 따라감", async () => {
  const { fake, fetchImpl, background } = setup();
  assert.equal((await send(background, checkMessage())).outcome, "measured");
  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, `${VERIFY_PREFIX}${CLAIM_ID}`);
  assert.ok(!url.includes(CLAIM_TOKEN));
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "include");
  assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "error");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.equal(init.headers["x-mi-coupang-claim-token"], CLAIM_TOKEN);
  assert.equal(init.headers["x-mi-coupang-check"], "1.0.0");
  assert.equal(init.body, undefined);
  // 빈 창(쿠팡 요청 0) → 다른 시크릿 창 검사 → 서버 확인 → 그 탭만 쿠팡으로(지난 검토: 확인을 먼저 하면 창을 못 열 때 1번을 헛되이 씀)
  const order = fake.log.filter((name) => ["fetch", "windows.create", "windows.getAll", "tabs.update"].includes(name));
  assert.deepEqual(order, ["windows.getAll", "windows.create", "windows.getAll", "fetch", "tabs.update"]);
});

test("서버 확인 거절은 쿠팡 주소를 넣지 않고 빈 창을 닫고 사유를 넘긴다: 간격·그날 중지·기한·세션·총관리자 아님·연결 실패·5xx·모양 틀림", async () => {
  const cases = [
    [{ status: 409, body: { ok: false, code: "COUPANG_MANUAL_GAP", state: "gap", retryAfterSec: 42 } }, "verify_refused", "COUPANG_MANUAL_GAP"],
    [{ status: 409, body: { ok: false, code: "COUPANG_MANUAL_STOPPED", state: "stopped" } }, "verify_refused", "COUPANG_MANUAL_STOPPED"],
    [{ status: 410, body: { ok: false, code: "COUPANG_MANUAL_CLAIM_EXPIRED" } }, "verify_refused", "COUPANG_MANUAL_CLAIM_EXPIRED"],
    [{ status: 400, body: { ok: false, code: "COUPANG_ACTION_INVALID" } }, "verify_refused", "COUPANG_ACTION_INVALID"],
    [{ status: 401, body: { ok: false, code: "SESSION_REQUIRED" } }, "verify_refused", "SESSION_REQUIRED"],
    [{ status: 403, body: { ok: false, code: "COUPANG_OWNER_ONLY" } }, "verify_refused", "COUPANG_OWNER_ONLY"],
    [{ status: 403, text: "<html>no</html>" }, "verify_refused", null],
    [new Error("Failed to fetch"), "verify_unreachable", null],
    [{ status: 503, body: { ok: false, code: "COUPANG_SETUP_REQUIRED" } }, "verify_unreachable", "COUPANG_SETUP_REQUIRED"],
    [{ status: 200, body: { ok: true, verified: true, claimId: CLAIM_ID_2, keyword: SERVER_KEYWORD } }, "verify_unreachable", null],
    [{ status: 200, body: { ok: true, claimId: CLAIM_ID, keyword: SERVER_KEYWORD } }, "verify_unreachable", null],
    [{ status: 200, body: { ok: true, verified: true, claimId: CLAIM_ID, keyword: "" } }, "verify_unreachable", null],
    [{ status: 200, body: { ok: true, verified: true, claimId: CLAIM_ID, keyword: "a\u0000b" } }, "verify_unreachable", null],
    [{ status: 200, text: "not json" }, "verify_unreachable", null],
  ];
  for (const [outcome, code, serverCode] of cases) {
    const { fake, fetchImpl, background } = setup({ fetch: () => outcome });
    const reply = await send(background, checkMessage());
    const label = JSON.stringify(outcome.body || outcome.text || String(outcome));
    assert.equal(reply.outcome, "not_started", label);
    assert.equal(reply.code, code, label);
    assert.equal(reply.serverCode, serverCode, label);
    assert.equal(reply.windowLeftOpen, false, label);
    assert.equal(fake.calls.create.length, 1, "빈 창 1개");
    assert.equal(fake.windows.size, 0, "빈 창은 닫는다");
    noSearch(fake, fetchImpl, { verifies: 1 });
    if (serverCode === "COUPANG_MANUAL_GAP") {
      assert.equal(reply.retryAfterSec, 42);
      assert.equal(reply.serverState, "gap");
    }
    if (outcome.status === 401) assert.equal(reply.httpStatus, 401);
  }
});

test("서버 확인이 답하지 않으면 제한 시간 뒤 verify_unreachable(쿠팡 요청 0, 빈 창 닫음)", async () => {
  const { fake, background } = setup({
    fetch: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
    timing: { serverTimeoutMs: 30 },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.code, "verify_unreachable");
  assert.equal(fake.calls.update.length, 0);
  assert.equal(fake.windows.size, 0);
});

test("서버 확인을 기다리는 사이 사람이 빈 창을 닫으면 쿠팡 주소를 넣지 않고 window_closed_early(검색 0)", async () => {
  let fakeRef;
  const { fake, fetchImpl, background } = setup({
    fetch: async (url, init) => {
      fakeRef.closeWindowByUser(fakeRef.lastWindowId());
      await sleep(5);
      return defaultVerify(url, init);
    },
  });
  fakeRef = fake;
  const reply = await send(background, checkMessage());
  assert.equal(reply.outcome, "not_started");
  assert.equal(reply.code, "window_closed_early");
  assert.equal(reply.windowLeftOpen, false);
  noSearch(fake, fetchImpl, { verifies: 1 });
  assert.equal(fake.storage.active, undefined);
});

test("창의 검색어는 화면이 보낸 값이 아니라 서버가 확인해 준 값", async () => {
  const { fake, background } = setup({ fetch: (url, init) => defaultVerify(url, init, { keyword: "서버 검색어" }) });
  const reply = await send(background, checkMessage({ keyword: "화면이 보낸 다른 검색어" }));
  assert.equal(reply.keyword, "서버 검색어");
  assert.equal(fake.calls.update[0].url, searchUrl("서버 검색어"));
});

test("맥 시계가 서버와 몇 시간 어긋나도 확인은 거절되지 않고, 날짜는 서버 시각으로 센다", async () => {
  const serverTime = "2026-10-23T05:00:00.000Z"; // KST 14:00
  const mac = Date.parse("2026-10-22T18:30:00.000Z"); // 맥은 10시간 30분 늦음(KST 전날 03:30)
  const { fake, background } = setup({ now: () => mac, serverTime, chrome: { scenario: { measure: BLOCKED_403 } } });
  const reply = await send(background, checkMessage());
  assert.equal(reply.outcome, "measured");
  assert.equal(fake.storage.blockedDay, "2026-10-23", "그날 = 서버의 한국 날짜");
  assert.equal(fake.storage.serverOffsetMs, Date.parse(serverTime) - mac);
  assert.equal(fake.storage.pending.serverDay, "2026-10-23");
});

// ── 창 만들기(지난 결함: windows.create null) ──

test("창: 빈 시크릿 창을 포커스 없이 먼저 열고(about:blank·focused:false·1280×900), 서버 확인 뒤에만 앞으로 가져와 그 탭을 쿠팡 검색 1쪽으로 보낸다", async () => {
  const { fake, background } = setup();
  assert.equal((await send(background, checkMessage())).outcome, "measured");
  assert.deepEqual(fake.calls.create, [{ url: "about:blank", incognito: true, focused: false, type: "normal", width: 1280, height: 900 }]);
  assert.deepEqual(fake.calls.windowsUpdate, [{ id: fake.lastWindowId(), focused: true }]);
  const order = fake.log.filter((name) => ["fetch", "windows.create", "windows.update", "tabs.update"].includes(name));
  assert.deepEqual(order, ["windows.create", "fetch", "windows.update", "tabs.update"], "앞으로 가져오기는 서버 확인 뒤·쿠팡 이동 전");
  assert.equal(fake.calls.update.length, 1);
  assert.equal(fake.calls.update[0].url, `https://www.coupang.com/np/search?q=${encodeURIComponent(SERVER_KEYWORD)}`);
  assert.equal(fake.calls.remove.length, 1, "창은 항상 닫는다");
  assert.equal(fake.windows.size, 0);
  assert.equal(fake.storage.active, undefined);
});

test("windows.create 가 빈 값을 주면 window_create_null + windowLeftOpen, 쿠팡 요청 0·서버 확인 0(횟수 안 씀)", async () => {
  const { fake, fetchImpl, background } = setup({ chrome: { createBehavior: "null" } });
  const reply = await send(background, checkMessage());
  assert.equal(reply.outcome, "not_started");
  assert.equal(reply.code, "window_create_null");
  assert.equal(reply.windowLeftOpen, true);
  noSearch(fake, fetchImpl, { verifies: 0 });
});

test("일반 창이 만들어지면 닫고 window_create_failed, 만들기 실패(정책)도 window_create_failed — 둘 다 쿠팡 요청 0·서버 확인 0(횟수 안 씀)", async () => {
  const normal = setup({ chrome: { createBehavior: "normal" } });
  assert.equal((await send(normal.background, checkMessage())).code, "window_create_failed");
  assert.equal(normal.fake.calls.remove.length, 1);
  noSearch(normal.fake, normal.fetchImpl, { verifies: 0 });
  const thrown = setup({ chrome: { createBehavior: "throw" } });
  assert.equal((await send(thrown.background, checkMessage())).code, "window_create_failed");
  noSearch(thrown.fake, thrown.fetchImpl, { verifies: 0 });
});

test("창 결과에 탭이 없으면 tabs.query 로 찾는다", async () => {
  const { fake, background } = setup({ chrome: { tabsInCreate: false } });
  assert.equal((await send(background, checkMessage())).outcome, "measured");
  assert.equal(fake.calls.query.length, 1);
});

test("빈 창을 연 사이 다른 시크릿 창이 생기면 서버 확인 없이 우리 창을 닫고 incognito_window_open(쿠팡 요청 0·횟수 안 씀)", async () => {
  const { fake, fetchImpl, background } = setup({ chrome: { extraIncognitoAfterCreate: true } });
  assert.equal((await send(background, checkMessage())).code, "incognito_window_open");
  noSearch(fake, fetchImpl, { verifies: 0 });
  assert.equal(fake.calls.remove.length, 1);
});

// ── 측정 결과 ──

test("정상: measured 답 모양·page 칸·창 닫음·보고 대기 저장(차단 아님 → 중지 알림 0)", async () => {
  const { fake, fetchImpl, background } = setup();
  const reply = await send(background, checkMessage());
  assert.deepEqual(Object.keys(reply).sort(), [
    "browser", "claimId", "durationMs", "extensionVersion", "keyword", "ok", "outcome", "page", "stopReason", "stopReported", "stopSignal", "windowLeftOpen",
  ].sort());
  assert.equal(reply.claimId, CLAIM_ID);
  assert.equal(reply.extensionVersion, "1.0.0");
  assert.equal(reply.browser, "chrome 141");
  assert.equal(reply.windowLeftOpen, false);
  assert.equal(reply.stopSignal, false);
  assert.equal(reply.stopReason, null);
  assert.equal(reply.stopReported, false);
  assert.ok(Number.isInteger(reply.durationMs) && reply.durationMs >= 0);
  const page = reply.page;
  assert.equal(page.status, "ok");
  assert.equal(page.httpStatus, 200);
  assert.equal(page.stable, true);
  assert.equal(page.organic.length, 50);
  assert.equal(page.ads.length, 10);
  assert.equal(page.itemCount, 60);
  assert.equal(page.finalHost, "www.coupang.com");
  assert.equal(page.finalPath, "/np/search");
  assert.equal(page.query, SERVER_KEYWORD);
  assert.equal(page.errorCode, null);
  assert.equal(fake.storage.pending.claimId, CLAIM_ID);
  assert.equal(fake.storage.pending.claimToken, CLAIM_TOKEN);
  assert.equal(fake.storage.pending.stop, false);
  assert.equal(fake.storage.blockedDay, undefined);
  assert.deepEqual(fetchImpl.stops(), []);
  const measure = fake.calls.executeScript.find((call) => call.func === "miCoupangMeasure" && !call.args[0].quick);
  assert.equal(measure.args[0].scrollCount, 8);
  assert.equal(measure.args[0].scrollPixels, 1400);
});

test("광고만 있고 일반 0개는 차단으로 보지 않는다(중지 알림 0, 그날 표시 없음)", async () => {
  const items = rawPage().items.filter((item) => item.ad).slice(0, 8);
  const { fake, fetchImpl, background } = setup({ chrome: { scenario: { measure: () => rawPage({ items, loginWall: false }) } } });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.status, "ok");
  assert.equal(reply.page.organic.length, 0);
  assert.equal(reply.page.ads.length, 8);
  assert.equal(reply.stopSignal, false);
  assert.deepEqual(fetchImpl.stops(), []);
  assert.equal(fake.storage.blockedDay, undefined);
});

test("차단 신호(403·429·HTTP 200+차단 문구)는 창을 닫은 뒤 서버에 바로 '그날 중지'(manual-stop) — 화면보다 먼저", async () => {
  for (const [raw, reason] of [
    [rawPage({ httpStatus: 403, items: [], blockedText: true, stable: false }), "blocked_http_403"],
    [rawPage({ httpStatus: 200, items: [], blockedText: true, stable: false }), "blocked_text"],
    [rawPage({ httpStatus: 429, items: [] }), "blocked_http_429"],
  ]) {
    const { fake, fetchImpl, background } = setup({ chrome: { scenario: { measure: () => raw } } });
    const reply = await send(background, checkMessage());
    assert.equal(reply.outcome, "measured");
    assert.equal(reply.page.status, "blocked");
    assert.equal(reply.stopSignal, true);
    assert.equal(reply.stopReason, reason);
    assert.equal(reply.stopReported, true);
    assert.deepEqual(fetchImpl.stops(), [{ claimId: CLAIM_ID, reason, token: CLAIM_TOKEN }]);
    const stopCall = fetchImpl.calls.find((call) => call.url.includes("view=manual-stop"));
    assert.equal(stopCall.url, `${SERVER}?view=manual-stop&claimId=${CLAIM_ID}&reason=${reason}`);
    assert.equal(stopCall.init.method, "GET");
    assert.ok(fake.log.indexOf("windows.remove") < fake.log.indexOf("fetch:stop"), "창을 먼저 닫는다");
    assert.equal(fake.storage.pending.stop, true);
    assert.equal(fake.storage.pending.stopReported, true);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(fake.storage.blockedDay));
    assert.equal(fake.storage.stopReportedDay, fake.storage.blockedDay);
  }
});

test("사람이 창을 닫음 → window_closed(차단 아님)", async () => {
  let fakeRef;
  const { fake, fetchImpl, background } = setup({
    chrome: {
      scenario: {
        measure: async ({ tab }) => {
          fakeRef.closeWindowByUser(tab.windowId);
          await sleep(1000);
          return rawPage();
        },
      },
    },
  });
  fakeRef = fake;
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "window_closed");
  assert.equal(reply.page.status, "error");
  assert.equal(reply.stopSignal, false);
  assert.equal(reply.windowLeftOpen, false);
  assert.equal(fake.storage.active, undefined);
  assert.deepEqual(fetchImpl.stops(), []);
});

test("45초 안에 다 불러오지 못함 → page_timeout, 짧은 읽기(바로 주입)로 HTTP 상태·차단 문구를 채운다(시간 초과+403 = 차단)", async () => {
  const { fake, fetchImpl, background } = setup({
    chrome: { scenario: { loadEvents: false, quick: () => ({ host: "www.coupang.com", path: "/np/search", httpStatus: 403, blockedText: false, items: [] }) } },
    timing: { loadTimeoutMs: 40 },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "page_timeout");
  assert.equal(reply.page.status, "timeout");
  assert.equal(reply.page.httpStatus, 403);
  assert.equal(reply.stopReason, "blocked_http_403");
  assert.equal(fetchImpl.stops().length, 1);
  const quick = fake.calls.executeScript.find((call) => call.args?.[0]?.quick === true);
  assert.equal(quick.injectImmediately, true);
  assert.ok(!fake.calls.executeScript.some((call) => call.func === "miCoupangMeasure" && call.args?.[0]?.quick !== true));
});

test("탭 'complete' 가 늦어도 쪽 안 readyState complete(주 문서 load)를 보면 측정한다", async () => {
  const { fake, background } = setup({
    chrome: { scenario: { loadEvents: false, probe: () => ({ readyState: "complete", host: "www.coupang.com", path: "/np/search" }) } },
    timing: { loadTimeoutMs: 400 },
  });
  assert.equal((await send(background, checkMessage())).page.status, "ok");
  assert.ok(fake.log.includes("probe"));
});

test("쪽 함수를 못 넣음: 주소가 검색 쪽이면 page_load_failed(차단 아님), 주소가 안 보이면(로그인 화면 등) page_unreadable = 차단(D1)", async () => {
  const errorPage = setup({ chrome: { scenario: { measure: () => { throw new Error("Frame with ID 0 is showing error page"); } } } });
  const first = await send(errorPage.background, checkMessage());
  assert.equal(first.page.errorCode, "page_load_failed");
  assert.equal(first.page.finalHost, "www.coupang.com");
  assert.equal(first.stopSignal, false);
  assert.deepEqual(errorPage.fetchImpl.stops(), []);

  const login = setup({
    chrome: {
      scenario: {
        finalUrl: () => "https://login.coupang.com/login/login.pang?rtnUrl=x",
        measure: () => { throw new Error("Cannot access contents of url"); },
      },
    },
  });
  const second = await send(login.background, checkMessage());
  assert.equal(second.page.errorCode, "page_unreadable");
  assert.equal(second.page.finalHost, "");
  assert.equal(second.stopReason, "page_unreadable");
  assert.deepEqual(login.fetchImpl.stops().map((stop) => stop.reason), ["page_unreadable"]);
  assert.ok(login.fake.storage.blockedDay);
});

test("측정 중 사람이 상품을 누름(주소가 쿠팡 다른 쪽) → user_navigated(차단 아님), 쪽 함수가 주소 바뀜을 알리면 user_navigated", async () => {
  let fakeRef;
  const clicked = setup({
    chrome: {
      scenario: {
        measure: ({ tab }) => {
          tab.url = "https://www.coupang.com/vp/products/12345678";
          fakeRef.events.tabsOnUpdated.emit(tab.id, { status: "loading" });
          throw new Error("The frame was removed.");
        },
      },
    },
  });
  fakeRef = clicked.fake;
  const reply = await send(clicked.background, checkMessage());
  assert.equal(reply.page.errorCode, "user_navigated");
  assert.equal(reply.page.finalPath, "/vp/products/12345678");
  assert.equal(reply.stopSignal, false);

  const moved = setup({ chrome: { scenario: { measure: () => rawPage({ navigated: true }) } } });
  const second = await send(moved.background, checkMessage());
  assert.equal(second.page.errorCode, "user_navigated");
  assert.equal(second.page.organic.length, 0);
});

test("120초 상한 → browser_hard_cap, 창은 닫고 짧은 읽기를 해 본다", async () => {
  const { fake, background } = setup({
    chrome: { scenario: { measure: () => new Promise(() => {}), quick: () => ({ host: "www.coupang.com", path: "/np/search", httpStatus: 200, items: [] }) } },
    timing: { hardCapMs: 80 },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "browser_hard_cap");
  assert.equal(reply.page.status, "error");
  assert.equal(reply.stopSignal, false);
  assert.equal(fake.calls.remove.length, 1);
  assert.ok(fake.log.includes("quick"));
});

// ── 첫 읽기 전에 끝난 회차에도 차단 신호를 남긴다(지난 검토: 창을 닫으면 차단 신호가 사라져 그날 중지가 안 걸림) ──

const LOGIN_URL = "https://login.coupang.com/login/login.pang?rtnUrl=x";
const NO_ACCESS = () => { throw new Error("Cannot access contents of url"); };

test("불러오는 동안 HTTP 403 을 본 뒤 사람이 첫 읽기 전에 창을 닫으면: window_closed 이지만 403 으로 서버 그날 중지", async () => {
  let fakeRef;
  let probes = 0;
  const { fake, fetchImpl, background } = setup({
    chrome: {
      scenario: {
        loadEvents: false,
        probe: ({ tab }) => {
          probes += 1;
          if (probes === 2) queueMicrotask(() => fakeRef.closeWindowByUser(tab.windowId));
          return { readyState: "interactive", host: "www.coupang.com", path: "/np/search", httpStatus: 403, blockedText: false };
        },
      },
    },
    timing: { loadTimeoutMs: 400 },
  });
  fakeRef = fake;
  const reply = await send(background, checkMessage());
  assert.equal(reply.outcome, "measured");
  assert.equal(reply.page.errorCode, "window_closed");
  assert.equal(reply.page.httpStatus, 403);
  assert.equal(reply.stopReason, "blocked_http_403");
  assert.equal(reply.stopReported, true);
  assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["blocked_http_403"]);
  assert.ok(fake.storage.blockedDay, "이 크롬의 그날 표시");
  assert.ok(!fake.log.includes("measure"), "쪽 함수의 첫 읽기 전에 닫힘");
});

test("불러온 직후 짧은 읽기가 차단 화면(HTTP 200 + 한국어 차단 문구)을 보면 기다리거나 스크롤하지 않고 끝내고 그날 중지", async () => {
  const { fake, fetchImpl, background } = setup({
    chrome: { scenario: { quick: () => rawPage({ httpStatus: 200, items: [], blockedText: true, stable: false, scrolls: 0, reads: 1 }) } },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.status, "blocked");
  assert.equal(reply.stopReason, "blocked_text");
  assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["blocked_text"]);
  assert.ok(!fake.log.includes("measure"), "차단 화면에서는 측정(스크롤)을 하지 않는다");
});

test("로그인 화면 등 권한 밖으로 보내진 것을 load 중에 본 뒤 사람이 창을 닫으면: page_unreadable(D1)로 그날 중지", async () => {
  let fakeRef;
  let probes = 0;
  const { fake, fetchImpl, background } = setup({
    chrome: {
      scenario: {
        loadEvents: false,
        finalUrl: () => LOGIN_URL,
        probe: ({ tab }) => {
          probes += 1;
          if (probes === 2) queueMicrotask(() => fakeRef.closeWindowByUser(tab.windowId));
          return NO_ACCESS();
        },
      },
    },
    timing: { loadTimeoutMs: 400 },
  });
  fakeRef = fake;
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "page_unreadable");
  assert.equal(reply.stopReason, "page_unreadable");
  assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["page_unreadable"]);
});

test("D1 시간 초과: 권한 밖 호스트로 보내져 45초 안에 load 가 끝나지 않으면 page_timeout 이 아니라 page_unreadable(그날 중지)", async () => {
  const unreadable = setup({
    chrome: { scenario: { loadEvents: false, finalUrl: () => LOGIN_URL, quick: NO_ACCESS } },
    timing: { loadTimeoutMs: 40 },
  });
  const reply = await send(unreadable.background, checkMessage());
  assert.equal(reply.page.errorCode, "page_unreadable");
  assert.equal(reply.page.finalHost, "");
  assert.equal(reply.stopReason, "page_unreadable");
  assert.deepEqual(unreadable.fetchImpl.stops().map((stop) => stop.reason), ["page_unreadable"]);
  // 대조: 쿠팡 검색 주소가 보이는데 늦을 뿐이면(차단 HTTP 없음) 시간 초과 = 차단 아님
  const slow = setup({ chrome: { scenario: { loadEvents: false, quick: NO_ACCESS } }, timing: { loadTimeoutMs: 40 } });
  const late = await send(slow.background, checkMessage());
  assert.equal(late.page.errorCode, "page_timeout");
  assert.equal(late.page.finalHost, "www.coupang.com");
  assert.equal(late.stopReason, null);
  assert.deepEqual(slow.fetchImpl.stops(), []);
});

test("120초 상한인데 권한 밖으로 보내져 읽지 못하면 page_unreadable(그날 중지)", async () => {
  const { fetchImpl, background } = setup({
    chrome: { scenario: { finalUrl: () => LOGIN_URL, quick: NO_ACCESS, measure: () => new Promise(() => {}) } },
    timing: { hardCapMs: 80 },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.page.errorCode, "page_unreadable");
  assert.deepEqual(fetchImpl.stops().map((stop) => stop.reason), ["page_unreadable"]);
});

test("측정 중 쿠팡이 주소 꼬리만 바꾸면(같은 경로·같은 q) 사람의 이동이 아니다, q 가 바뀌면 이동(user_navigated)", async () => {
  const cases = [
    [(tab) => `${tab.url}&channel=user&traceId=abc`, "page_load_failed"],
    [() => searchUrl("다른 검색어"), "user_navigated"],
  ];
  for (const [nextUrl, expected] of cases) {
    let fakeRef;
    const { fake, background } = setup({
      chrome: {
        scenario: {
          measure: ({ tab }) => {
            const url = nextUrl(tab);
            tab.url = url;
            fakeRef.events.tabsOnUpdated.emit(tab.id, { url });
            throw new Error("Frame with ID 0 is showing error page");
          },
        },
      },
    });
    fakeRef = fake;
    const reply = await send(background, checkMessage());
    assert.equal(reply.page.errorCode, expected, expected);
    assert.equal(reply.stopSignal, false);
  }
});

// 2026-10-23 재검사 r6: 경로·q 만 보던 탓에 정렬·쪽 번호가 바뀐 목록도 이동이 아니었다.
test("측정 중 주소의 정렬·쪽 번호·목록 크기가 바뀌면 이동(user_navigated), 쿠팡 기본값(1쪽·랭킹순)·추적 꼬리만이면 이동 아님", async () => {
  const cases = [
    [(url) => `${url}&sorter=saleCountDesc`, "user_navigated", null],
    [(url) => `${url}&page=2`, "user_navigated", null],
    [(url) => `${url}&listSize=72`, "user_navigated", null],
    [(url) => `${url}&page=1&sorter=scoreDesc&channel=user`, "page_load_failed", null],
    // 측정 시작 때 이미 붙어 있던 목록 값은 기준이다: 그 뒤 추적 꼬리만 붙으면 이동 아님, 값이 바뀌면 이동
    [(url) => `${url}&traceId=abc`, "page_load_failed", (url) => `${url}&listSize=36`],
    [(url) => url.replace("listSize=36", "listSize=72"), "user_navigated", (url) => `${url}&listSize=36`],
  ];
  for (const [nextUrl, expected, loadedUrl] of cases) {
    let fakeRef;
    const { fake, background } = setup({
      chrome: {
        scenario: {
          ...(loadedUrl ? { finalUrl: loadedUrl } : {}),
          measure: ({ tab }) => {
            const url = nextUrl(tab.url);
            tab.url = url;
            fakeRef.events.tabsOnUpdated.emit(tab.id, { url });
            throw new Error("Frame with ID 0 is showing error page");
          },
        },
      },
    });
    fakeRef = fake;
    const reply = await send(background, checkMessage());
    assert.equal(reply.page.errorCode, expected, `${nextUrl("U")} ${loadedUrl ? "(불러온 주소에 listSize=36)" : ""}`);
    assert.equal(reply.stopSignal, false);
  }
});

test("isSearchAddress: 같은 검색어의 검색 1쪽 + 목록 값이 기준과 같을 때만 참", () => {
  const url = searchUrl(SERVER_KEYWORD);
  assert.equal(isSearchAddress(url, SERVER_KEYWORD), true);
  assert.equal(isSearchAddress(`${url}&channel=user&page=1&sorter=scoreDesc`, SERVER_KEYWORD), true);
  for (const tail of ["&page=2", "&sorter=latestAsc", "&listSize=60"]) assert.equal(isSearchAddress(`${url}${tail}`, SERVER_KEYWORD), false, tail);
  assert.equal(isSearchAddress(`${url}&listSize=60`, SERVER_KEYWORD, { sorter: "scoreDesc", page: "1", listSize: "60" }), true);
  assert.equal(isSearchAddress(searchUrl("다른 검색어"), SERVER_KEYWORD), false);
  assert.equal(isSearchAddress("https://www.coupang.com/vp/products/1", SERVER_KEYWORD), false);
  assert.equal(isSearchAddress("not a url", SERVER_KEYWORD), false);
});

test("작업 중 15초마다 확장 API(windows.get) 호출로 서비스 워커를 깨워 둔다", async () => {
  const { fake, background } = setup({
    chrome: { scenario: { measure: async () => { await sleep(120); return rawPage(); } } },
    timing: { keepaliveMs: 15 },
  });
  assert.equal((await send(background, checkMessage())).outcome, "measured");
  const ours = fake.calls.windowsGet.filter((id) => id === fake.lastWindowId());
  assert.ok(ours.length >= 3, `windows.get ${ours.length}번`);
});

// ── 남은 시크릿 창(지난 결함: 정리·안내되지 않음) ──

test("워커 시작: 7분 안 기록의 시크릿 창은 닫고, 오래된 기록은 닫지 않고 안내, 없는 창은 기록만 지움", async () => {
  const clock = 10_000_000;
  const fresh = makeFakeChrome({ windows: [{ id: 61, incognito: true }], storage: { active: { windowId: 61, claimId: CLAIM_ID, startedAt: clock - 60_000 } } });
  const bgFresh = createBackground(fresh.chrome, { fetch: makeFakeFetch(), now: () => clock, timing: FAST_TIMING });
  await bgFresh.start();
  assert.deepEqual(fresh.calls.remove, [61]);
  assert.equal(fresh.storage.active, undefined);
  const hello = await send(bgFresh, { type: "mi-coupang-hello" });
  assert.deepEqual(hello.leftover, { closed: 1, unknown: false });
  assert.deepEqual((await send(bgFresh, { type: "mi-coupang-hello" })).leftover, { closed: 0, unknown: false }, "한 번만 알린다");

  const stale = makeFakeChrome({ windows: [{ id: 62, incognito: true }], storage: { active: { windowId: 62, claimId: CLAIM_ID, startedAt: clock - 10 * 60_000 } } });
  const bgStale = createBackground(stale.chrome, { fetch: makeFakeFetch(), now: () => clock, timing: FAST_TIMING });
  await bgStale.start();
  assert.deepEqual(stale.calls.remove, []);
  assert.equal(stale.storage.active, undefined);
  const staleHello = await send(bgStale, { type: "mi-coupang-hello" });
  assert.deepEqual(staleHello.leftover, { closed: 0, unknown: true });
  assert.equal(staleHello.incognitoWindowOpen, true, "남은 창은 다음 확인을 막는다(안전 쪽)");

  const gone = makeFakeChrome({ storage: { active: { windowId: 63, claimId: CLAIM_ID, startedAt: clock - 1000 } } });
  const bgGone = createBackground(gone.chrome, { fetch: makeFakeFetch(), now: () => clock, timing: FAST_TIMING });
  await bgGone.start();
  assert.equal(gone.storage.active, undefined);
});

test("창 닫기 실패 → windowLeftOpen=true·기록을 남기고(hello 가 알림), 다음 hello 가 다시 닫는다", async () => {
  const { fake, background } = setup({ chrome: { removeFails: true } });
  const reply = await send(background, checkMessage());
  assert.equal(reply.windowLeftOpen, true);
  assert.ok(fake.storage.active, "작업 중 기록이 남는다");
  const stillOpen = await send(background, { type: "mi-coupang-hello" });
  assert.deepEqual(stillOpen.leftover, { closed: 0, unknown: true });
  fake.config.removeFails = false;
  const hello = await send(background, { type: "mi-coupang-hello" });
  assert.deepEqual(hello.leftover, { closed: 1, unknown: false });
  assert.equal(fake.storage.active, undefined);
  assert.equal(fake.windows.size, 0);
});

test("startBackground: onMessageExternal 에 리스너 1개만 단다(알람·설치 이벤트 없음)", () => {
  const fake = makeFakeChrome();
  const background = startBackground(fake.chrome, { fetch: makeFakeFetch(), timing: FAST_TIMING });
  assert.equal(fake.events.onMessageExternal.size, 1);
  assert.ok(fake.events.onMessageExternal.hasListener(background.listener));
  assert.equal(fake.chrome.alarms, undefined);
});

// ── 차단 결과가 서버 '그날 중지'로 가는 길(지난 결함: 확장만 본 차단이 서버로 안 감) ──

test("관리자 탭이 닫혀 결과를 못 보내도: 확장이 이미 manual-stop 으로 그날 중지를 걸었고, 새 탭의 hello·다음 누름이 결과(토큰 포함)를 다시 준다", async () => {
  const clock = clockFrom(20_000_000);
  const { fake, fetchImpl, background } = setup({ now: clock.now, chrome: { scenario: { measure: BLOCKED_403 } } });
  const blocked = await send(background, checkMessage());
  assert.equal(blocked.stopReported, true);
  const hello = await send(background, { type: "mi-coupang-hello" });
  assert.equal(hello.pending.claimId, CLAIM_ID);
  assert.equal(hello.pending.claimToken, CLAIM_TOKEN);
  assert.equal(hello.pending.stop, true);
  assert.equal(hello.pending.stopReason, "blocked_http_403");
  assert.equal(hello.pending.stopReported, true);
  assert.equal(hello.pending.reply.outcome, "measured");
  assert.equal(hello.pending.reply.page.httpStatus, 403);
  // 그 사이 새 검색은 없다(서버 확인도 안 함): report_pending + 남은 결과(화면이 manual-record 로 보낸다).
  clock.value += 200_000;
  const next = await send(background, checkMessage({ claimId: CLAIM_ID_2 }));
  assert.equal(next.code, "report_pending");
  assert.equal(next.stopReported, true);
  assert.equal(next.pending.claimId, CLAIM_ID);
  assert.equal(next.pending.reply.page.httpStatus, 403);
  assert.equal(fetchImpl.views().filter((view) => view === "manual-verify").length, 1);
  assert.equal(fetchImpl.stops().length, 1, "이미 알렸으면 다시 알리지 않는다");
  // 화면이 manual-record 를 마치고 ack → 남은 결과 지움. 그래도 그날은 새 검색 없음.
  assert.deepEqual(await send(background, { type: "mi-coupang-ack", claimId: CLAIM_ID_2 }), { ok: true, type: "ack", cleared: false });
  assert.deepEqual(await send(background, { type: "mi-coupang-ack", claimId: CLAIM_ID }), { ok: true, type: "ack", cleared: true });
  assert.equal(fake.storage.pending, undefined);
  const sameDay = await send(background, checkMessage({ claimId: CLAIM_ID_3 }));
  assert.equal(sameDay.code, "blocked_today");
  assert.equal(fake.calls.create.length, 1);
});

test("중지 알림이 실패하면(서버 연결 실패) 다음 누름 때 그 결과의 토큰으로 다시 알리고, 그래도 새 검색은 하지 않는다", async () => {
  const clock = clockFrom(21_000_000);
  let serverUp = false;
  const { fetchImpl, background } = setup({
    now: clock.now,
    chrome: { scenario: { measure: () => rawPage({ httpStatus: 200, items: [], blockedText: true }) } },
    fetch: (url, init, { view, used }) => {
      if (view === "manual-stop") return serverUp ? { status: 200, body: { ok: true, stopped: true } } : new Error("Failed to fetch");
      const claimId = new URL(url).searchParams.get("claimId");
      used.add(claimId);
      return defaultVerify(url, init);
    },
  });
  const first = await send(background, checkMessage());
  assert.equal(first.stopReason, "blocked_text");
  assert.equal(first.stopReported, false);
  // 같은 실행 안에서 0·3·10초(테스트는 짧게)에 3번 보내 본다
  assert.equal(fetchImpl.stops().length, 3);
  clock.value += 200_000;
  serverUp = true;
  const next = await send(background, checkMessage({ claimId: CLAIM_ID_2 }));
  assert.equal(next.code, "report_pending");
  assert.equal(next.stopReported, true);
  assert.deepEqual(fetchImpl.stops().map((stop) => [stop.claimId, stop.reason]), Array.from({ length: 4 }, () => [CLAIM_ID, "blocked_text"]));
  assert.equal(fetchImpl.views().filter((view) => view === "manual-verify").length, 1);
});

test("중지 알림이 한두 번 실패해도 같은 실행 안에서 다시 보내 서버 그날 중지를 건다(관리자 탭이 닫혀도 다른 설치가 같은 날 검색하지 않게)", async () => {
  let failures = 2;
  const { fake, fetchImpl, background } = setup({
    chrome: { scenario: { measure: BLOCKED_403 } },
    fetch: (url, init, { view, used }) => {
      if (view === "manual-stop") {
        if (failures > 0) {
          failures -= 1;
          return new Error("Failed to fetch");
        }
        return { status: 200, body: { ok: true, stopped: true } };
      }
      used.add(new URL(url).searchParams.get("claimId"));
      return defaultVerify(url, init);
    },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.stopReason, "blocked_http_403");
  assert.equal(reply.stopReported, true);
  assert.equal(fetchImpl.stops().length, 3);
  assert.equal(fake.storage.pending.stopReported, true);
  assert.equal(fake.storage.pending.reply.stopReported, true);
  assert.equal(fake.storage.stopReportedDay, fake.storage.blockedDay);
});

test("중지 알림이 실행 안에서 모두 실패하면 결과·그날 표시는 먼저 남기고, 다음 hello(관리자 화면을 열 때)가 다시 보낸다", async () => {
  let serverUp = false;
  const { fake, fetchImpl, background } = setup({
    chrome: { scenario: { measure: BLOCKED_403 } },
    fetch: (url, init, { view, used }) => {
      if (view === "manual-stop") return serverUp ? { status: 200, body: { ok: true, stopped: true } } : new Error("Failed to fetch");
      used.add(new URL(url).searchParams.get("claimId"));
      return defaultVerify(url, init);
    },
  });
  const reply = await send(background, checkMessage());
  assert.equal(reply.stopReported, false);
  assert.equal(fake.storage.pending.stop, true);
  assert.equal(fake.storage.pending.stopReported, false);
  assert.ok(fake.storage.blockedDay, "알림이 실패해도 이 크롬의 그날 표시는 남는다");
  serverUp = true;
  const hello = await send(background, { type: "mi-coupang-hello" });
  assert.equal(hello.pending.stop, true);
  await sleep(20);
  assert.equal(fetchImpl.stops().length, 4, "실행 안 3번 + hello 1번");
  assert.equal(fake.storage.pending.stopReported, true);
  assert.equal(fake.storage.pending.reply.stopReported, true);
  assert.equal(fake.storage.stopReportedDay, fake.storage.blockedDay);
  // 이미 알렸으면 다음 hello 는 다시 보내지 않는다
  await send(background, { type: "mi-coupang-hello" });
  await sleep(10);
  assert.equal(fetchImpl.stops().length, 4);
});

test("남은 결과를 지운 뒤에도 그날 표시가 있고 서버에 알린 기록이 없으면, 이번 요청 토큰으로 extension_reported 를 알린다", async () => {
  const clock = Date.parse("2026-10-23T03:00:00.000Z");
  const fake = makeFakeChrome({ storage: { serverOffsetMs: 0, blockedDay: "2026-10-23" } });
  const fetchImpl = makeFakeFetch(null, fake.log);
  const background = createBackground(fake.chrome, { fetch: fetchImpl, now: () => clock, timing: FAST_TIMING, measure: ZERO_MEASURE });
  const reply = await send(background, checkMessage({ claimId: CLAIM_ID_2 }));
  assert.equal(reply.code, "blocked_today");
  assert.equal(reply.stopReported, true);
  assert.deepEqual(fetchImpl.stops(), [{ claimId: CLAIM_ID_2, reason: "extension_reported", token: CLAIM_TOKEN }]);
  assert.equal(fake.storage.stopReportedDay, "2026-10-23");
  const again = await send(background, checkMessage({ claimId: CLAIM_ID_3 }));
  assert.equal(again.code, "blocked_today");
  assert.equal(fetchImpl.stops().length, 1);
  assert.equal(fake.calls.create.length, 0);
});

test("그날 표시는 서버 날짜가 바뀌면 풀린다(다음 날 자동, D2 해제 버튼 없음)", async () => {
  const clock = clockFrom(Date.parse("2026-10-23T05:00:00.000Z"));
  const measure = { value: BLOCKED_403 };
  const { fake, fetchImpl, background } = setup({
    now: clock.now,
    serverTime: () => new Date(clock.value).toISOString(),
    chrome: { scenario: { measure: () => measure.value() } },
  });
  await send(background, checkMessage());
  await send(background, { type: "mi-coupang-ack", claimId: CLAIM_ID });
  clock.value += 24 * 3600_000;
  measure.value = () => rawPage();
  const nextDay = await send(background, checkMessage({ claimId: CLAIM_ID_2 }));
  assert.equal(nextDay.outcome, "measured");
  assert.equal(fetchImpl.views().filter((view) => view === "manual-verify").length, 2);
  assert.equal(fake.storage.blockedDay, "2026-10-23");
});

test("지난 날의 차단 결과·10분 지난 차단 아닌 결과는 다시 주지 않고 지운다", async () => {
  const clock = Date.parse("2026-10-24T01:00:00.000Z");
  const old = makeFakeChrome({ storage: { serverOffsetMs: 0, pending: { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, reply: { ok: true }, savedAt: clock - 86_400_000, serverDay: "2026-10-23", stop: true } } });
  const bgOld = createBackground(old.chrome, { fetch: makeFakeFetch(), now: () => clock, timing: FAST_TIMING });
  assert.equal((await send(bgOld, { type: "mi-coupang-hello" })).pending, null);
  assert.equal(old.storage.pending, undefined);

  const late = makeFakeChrome({ storage: { serverOffsetMs: 0, pending: { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, reply: { ok: true }, savedAt: clock - 11 * 60_000, serverDay: "2026-10-24", stop: false } } });
  const bgLate = createBackground(late.chrome, { fetch: makeFakeFetch(), now: () => clock, timing: FAST_TIMING });
  assert.equal((await send(bgLate, { type: "mi-coupang-hello" })).pending, null);

  const fresh = makeFakeChrome({ storage: { serverOffsetMs: 0, pending: { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, reply: { ok: true }, savedAt: clock - 60_000, serverDay: "2026-10-24", stop: false } } });
  const bgFresh = createBackground(fresh.chrome, { fetch: makeFakeFetch(), now: () => clock, timing: FAST_TIMING });
  assert.equal((await send(bgFresh, { type: "mi-coupang-hello" })).pending.claimId, CLAIM_ID);
});

test("차단 아닌 보고 대기 결과는 새 검색을 막지 않는다(다음 결과로 바뀜)", async () => {
  const clock = clockFrom(30_000_000);
  const { fake, background } = setup({ now: clock.now });
  await send(background, checkMessage());
  clock.value += 200_000;
  assert.equal((await send(background, checkMessage({ claimId: CLAIM_ID_2 }))).outcome, "measured");
  assert.equal(fake.storage.pending.claimId, CLAIM_ID_2);
});

test("모든 서버 요청은 우리 서버의 manual-verify·manual-stop 뿐이고, 쿠팡에는 fetch 하지 않는다", async () => {
  const clock = clockFrom(40_000_000);
  const measures = [() => rawPage(), BLOCKED_403];
  const { fetchImpl, background } = setup({ now: clock.now, chrome: { scenario: { measure: () => (measures.shift() || rawPage)() } } });
  for (const id of [CLAIM_ID, CLAIM_ID_2, CLAIM_ID_3]) {
    await send(background, checkMessage({ claimId: id }));
    clock.value += 200_000;
  }
  assert.deepEqual(fetchImpl.views(), ["manual-verify", "manual-verify", "manual-stop"], "세 번째는 그날 중지라 서버 확인도 하지 않는다");
  for (const call of fetchImpl.calls) assert.ok(call.url.startsWith(`${SERVER}?view=manual-`), call.url);
});

test("예기치 못한 오류: 쿠팡 주소를 넣기 전이면 extension_error(검색 0), 넣은 뒤면 measured extract_failed — 어느 쪽이든 창은 닫는다", async () => {
  let calls = 0;
  const before = setup({
    now: () => {
      calls += 1;
      if (calls === 5) throw new TypeError("boom"); // 오늘(1)·간격(2)·창 연 시각(3)·확인 시각(4) 다음, 마지막 검색 시각 저장(5)
      return 50_000_000 + calls;
    },
  });
  const first = await send(before.background, checkMessage());
  assert.equal(first.code, "extension_error");
  assert.equal(before.fake.calls.update.length, 0);
  assert.equal(before.fake.calls.remove.length, 1);
  assert.equal(before.fake.storage.active, undefined);

  const after = setup({ chrome: { scenario: { measure: () => ({ result: new Proxy({}, { get(_, key) { if (key === "then") return undefined; throw new TypeError("bad result"); } }) }).result } } });
  const second = await send(after.background, checkMessage());
  assert.equal(second.outcome, "measured");
  assert.equal(second.page.errorCode, "extract_failed");
  assert.equal(after.fake.calls.remove.length, 1);
  assert.equal(after.fake.storage.active, undefined);
});

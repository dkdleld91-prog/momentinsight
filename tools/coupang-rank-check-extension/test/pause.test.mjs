// 확장 1.0.3 차단 기억(대표 결정 2026-10-28 = 서버 c30-5 와 같은 규칙): 차단될 때마다 30분 쉼, 그날 중지는 없다.
// 1.0.1·1.0.2 가 남긴 그날 중지 기억(blockedDay)은 30분 쉼으로 한 번 바꾼다.
// 가짜 chrome·가짜 fetch 만 쓴다(쿠팡·서버 요청 0번). 시각은 서버 시각(가짜 fetch 의 serverTime)과 같은 시계로 움직인다.
import assert from "node:assert/strict";
import test from "node:test";
import { createBackground } from "../background.js";
import * as protocol from "../lib/protocol.js";
import { NOT_STARTED_CODES, PAUSE_MS } from "../lib/protocol.js";
import {
  CHROME_UA, CLAIM_ID, CLAIM_ID_2, CLAIM_ID_3, CLAIM_TOKEN, FAST_TIMING,
  checkMessage, makeFakeChrome, makeFakeFetch, rawPage, send,
} from "./helpers.mjs";

const ZERO_MEASURE = { settleMs: 0, gapMin: 0, gapMax: 0, readGapMs: 0 };
const BLOCKED_403 = () => rawPage({ httpStatus: 403, items: [], blockedText: false, stable: false });
const CLAIM_ID_4 = "3ebc6f4b-5d70-4b92-8d4e-6f80ab2c4d5e";
const CLAIM_ID_5 = "4fcd7a5c-6e81-4ca3-9e5f-70a1bc3d5e6f";
const START = Date.parse("2026-10-27T05:39:00.000Z"); // KST 14:39(대표가 막힌 시각)

function setup({ storage, measure } = {}) {
  const clock = { value: START };
  const scenario = { value: measure || BLOCKED_403 };
  const fake = makeFakeChrome({ storage, scenario: { measure: () => scenario.value() } });
  const fetchImpl = makeFakeFetch(null, fake.log, { serverTime: () => new Date(clock.value).toISOString() });
  const background = createBackground(fake.chrome, {
    fetch: fetchImpl, now: () => clock.value, timing: FAST_TIMING, measure: ZERO_MEASURE, uaText: CHROME_UA,
  });
  const verifies = () => fetchImpl.views().filter((view) => view === "manual-verify").length;
  return { clock, scenario, fake, fetchImpl, background, verifies };
}

async function checkAndAck(ctx, claimId) {
  const reply = await send(ctx.background, checkMessage({ claimId }));
  await send(ctx.background, { type: "mi-coupang-ack", claimId });
  return reply;
}

test("상수: 30분 = 서버 MANUAL_PAUSE_MINUTES, 두 번째 규칙 상수 없음, 시작 못 함 코드 blocked_pause", () => {
  assert.equal(PAUSE_MS, 30 * 60 * 1000);
  assert.equal(Object.hasOwn(protocol, "BLOCKS_PER_DAY_STOP"), false, "1.0.3: 같은 날 두 번째 그날 중지 규칙 없음");
  assert.equal(protocol.EXTENSION_VERSION, "1.0.4");
  assert.ok(NOT_STARTED_CODES.includes("blocked_pause"));
  assert.equal(FAST_TIMING.pauseMs, undefined, "시험도 진짜 30분을 쓴다(시계만 옮긴다)");
});

test("첫 차단 → 30분 쉼: 기억(blockDay·blockCount 1·pausedUntil = 서버 시각 + 30분, 그날 중지 아님), 쉬는 동안 새 검색 0번(blocked_pause·남은 초)", async () => {
  const ctx = setup();
  const first = await checkAndAck(ctx, CLAIM_ID);
  assert.deepEqual([first.outcome, first.stopReason, first.stopReported], ["measured", "blocked_http_403", true]);
  assert.equal(ctx.fake.calls.update.length, 1, "검색 1번 = tabs.update 1번");
  const store = ctx.fake.storage;
  assert.deepEqual([store.blockDay, store.blockCount, store.blockedDay, store.stopReportedDay], ["2026-10-27", 1, undefined, "2026-10-27"]);
  assert.ok(Math.abs(store.pausedUntil - (START + PAUSE_MS)) < 5_000, "쉼 끝 = 서버 시각 + 30분");
  // 29분 뒤: 서버가 (모르고) 허락해도 확장이 새 검색을 하지 않는다. 이미 알렸으므로 다시 알리지 않는다.
  ctx.clock.value = START + 29 * 60_000;
  const paused = await send(ctx.background, checkMessage({ claimId: CLAIM_ID_2 }));
  assert.deepEqual([paused.outcome, paused.code, paused.stopReported], ["not_started", "blocked_pause", true]);
  assert.ok(paused.retryAfterSec > 0 && paused.retryAfterSec <= 61, `남은 초 ${paused.retryAfterSec}`);
  assert.deepEqual([ctx.fake.calls.update.length, ctx.fake.calls.create.length, ctx.verifies(), ctx.fetchImpl.stops().length], [1, 1, 1, 1]);
});

test("차단될 때마다 30분 쉼: 30분 뒤 허용 → 두 번째 차단도 30분 쉼(blockCount 2, 그날 중지 없음) → 30분 뒤 다시 허용 → 세 번째도 쉼", async () => {
  const ctx = setup();
  await checkAndAck(ctx, CLAIM_ID);
  ctx.clock.value = START + PAUSE_MS + 60_000;
  ctx.scenario.value = () => rawPage();
  const ok = await checkAndAck(ctx, CLAIM_ID_2);
  assert.deepEqual([ok.outcome, ok.page.status, ok.stopSignal], ["measured", "ok", false]);
  assert.equal(ctx.fake.calls.update.length, 2);
  assert.equal(ctx.fake.storage.blockCount, 1, "성공은 차단 수를 바꾸지 않는다");
  // 같은 날 두 번째 차단 → 그날 중지가 아니라 다시 30분 쉼
  ctx.clock.value += 5 * 60_000;
  const secondAt = ctx.clock.value;
  ctx.scenario.value = () => rawPage({ httpStatus: 429, items: [] });
  const second = await checkAndAck(ctx, CLAIM_ID_3);
  assert.deepEqual([second.stopReason, second.stopReported], ["blocked_http_429", true]);
  let store = ctx.fake.storage;
  assert.deepEqual([store.blockDay, store.blockCount, store.blockedDay], ["2026-10-27", 2, undefined]);
  assert.ok(Math.abs(store.pausedUntil - (secondAt + PAUSE_MS)) < 5_000, "두 번째 차단 뒤에도 쉼 끝 = 그 차단 + 30분");
  assert.equal(ctx.fake.calls.update.length, 3);
  // 29분 뒤: 쉬는 중(새 검색 0번), 31분 뒤: 다시 검색
  ctx.clock.value = secondAt + 29 * 60_000;
  const paused = await send(ctx.background, checkMessage({ claimId: CLAIM_ID }));
  assert.deepEqual([paused.code, paused.stopReported], ["blocked_pause", true]);
  assert.equal(ctx.fake.calls.update.length, 3);
  ctx.clock.value = secondAt + PAUSE_MS + 60_000;
  ctx.scenario.value = () => rawPage({ httpStatus: 403, items: [] });
  const third = await checkAndAck(ctx, CLAIM_ID_4);
  assert.equal(third.stopReason, "blocked_http_403");
  store = ctx.fake.storage;
  assert.deepEqual([store.blockCount, store.blockedDay, ctx.fake.calls.update.length], [3, undefined, 4]);
  assert.ok(store.pausedUntil > ctx.clock.value, "세 번째도 30분 쉼");
  // 몇 시간 뒤(같은 날): 쉼이 끝나 다시 검색(그날 중지 없음)
  ctx.clock.value += 3 * 3600_000;
  ctx.scenario.value = () => rawPage();
  const later = await checkAndAck(ctx, CLAIM_ID_5);
  assert.equal(later.outcome, "measured");
  assert.deepEqual([ctx.fake.calls.update.length, ctx.verifies()], [5, 5], "검색 1번 = tabs.update 1번");
});

test("다음 날(서버 KST) 초기화: 어제 차단 두 번·1.0.2 그날 표시(어제)여도 오늘은 검색하고 어제 표시는 지운다, 오늘 첫 차단은 30분 쉼(blockCount 1)", async () => {
  const ctx = setup({ storage: { serverOffsetMs: 0, blockDay: "2026-10-26", blockCount: 2, blockedDay: "2026-10-26", pausedUntil: START - 20 * 3600_000, stopReportedDay: "2026-10-26" } });
  const reply = await checkAndAck(ctx, CLAIM_ID);
  assert.equal(reply.outcome, "measured");
  assert.equal(ctx.fake.calls.update.length, 1);
  const store = ctx.fake.storage;
  assert.deepEqual([store.blockDay, store.blockCount, store.blockedDay], ["2026-10-27", 1, undefined]);
  assert.ok(store.pausedUntil > START);
});

test("서버가 차단을 모를 때(알림 실패): 쉬는 동안 누르면 이번 요청 토큰으로 extension_reported 를 알리고 검색 0번", async () => {
  const clock = { value: START };
  const fake = makeFakeChrome({ storage: { serverOffsetMs: 0, blockDay: "2026-10-27", blockCount: 1, pausedUntil: START + 10 * 60_000 } });
  const fetchImpl = makeFakeFetch(null, fake.log, { serverTime: () => new Date(clock.value).toISOString() });
  const background = createBackground(fake.chrome, { fetch: fetchImpl, now: () => clock.value, timing: FAST_TIMING, measure: ZERO_MEASURE, uaText: CHROME_UA });
  const reply = await send(background, checkMessage({ claimId: CLAIM_ID_2 }));
  assert.deepEqual([reply.code, reply.stopReported, reply.retryAfterSec], ["blocked_pause", true, 600]);
  assert.deepEqual(fetchImpl.stops(), [{ claimId: CLAIM_ID_2, reason: "extension_reported", token: CLAIM_TOKEN }]);
  assert.equal(fake.storage.stopReportedDay, "2026-10-27");
  assert.deepEqual([fake.calls.create.length, fake.calls.update.length], [0, 0]);
  const again = await send(background, checkMessage({ claimId: CLAIM_ID_3 }));
  assert.equal(again.code, "blocked_pause");
  assert.equal(fetchImpl.stops().length, 1, "이미 알렸으면 다시 알리지 않는다");
});

test("1.0.1·1.0.2 에서 덮어쓴 날: 남은 오늘 그날 표시(blockedDay)는 그 차단 검색(lastCheckAt)부터 30분 쉼으로 한 번 바꾼다(그날 중지로 남기지 않음 — 대표 결정)", async () => {
  // 10분 전 검색에서 차단(1.0.1 첫 차단 또는 1.0.2 두 번째 차단) → 20분 남은 쉼, 검색 0번, 이미 알렸으면 다시 알리지 않음
  const recent = setup({ storage: { serverOffsetMs: 0, blockedDay: "2026-10-27", blockDay: "2026-10-27", blockCount: 2, pausedUntil: START - 40 * 60_000,
    stopReportedDay: "2026-10-27", lastCheckAt: START - 10 * 60_000 } });
  const refused = await send(recent.background, checkMessage());
  assert.equal(refused.code, "blocked_pause");
  assert.ok(Math.abs(refused.retryAfterSec - 20 * 60) <= 1, `남은 초 ${refused.retryAfterSec}`);
  assert.deepEqual([recent.fake.calls.update.length, recent.fake.calls.create.length, recent.verifies(), recent.fetchImpl.stops().length], [0, 0, 0, 0]);
  assert.equal(recent.fake.storage.blockedDay, undefined, "그날 표시는 지운다");
  assert.equal(recent.fake.storage.pausedUntil, START + 20 * 60_000);
  // 쉼이 끝나면 같은 날에도 다시 검색한다(검색 뒤에도 쉼이 다시 생기지 않는다)
  recent.clock.value = START + 21 * 60_000;
  recent.scenario.value = () => rawPage();
  const measured = await checkAndAck(recent, CLAIM_ID_2);
  assert.equal(measured.outcome, "measured");
  recent.clock.value += 5 * 60_000;
  const again = await checkAndAck(recent, CLAIM_ID_3);
  assert.equal(again.outcome, "measured");
  assert.deepEqual([recent.fake.calls.update.length, recent.verifies()], [2, 2]);

  // 2시간 전 차단 → 이미 30분이 지나 바로 검색
  const old = setup({ storage: { serverOffsetMs: 0, blockedDay: "2026-10-27", stopReportedDay: "2026-10-27", lastCheckAt: START - 2 * 3600_000 }, measure: () => rawPage() });
  assert.equal((await send(old.background, checkMessage())).outcome, "measured");
  assert.equal(old.fake.storage.blockedDay, undefined);

  // 검색 시각을 모르거나(없음) 맥 시계로 미래면 지금부터 30분(더 엄격한 쪽)
  for (const lastCheckAt of [undefined, START + 3600_000]) {
    const unknown = setup({ storage: { serverOffsetMs: 0, blockedDay: "2026-10-27", stopReportedDay: "2026-10-27", ...(lastCheckAt ? { lastCheckAt } : {}) } });
    const reply = await send(unknown.background, checkMessage());
    assert.deepEqual([reply.code, reply.retryAfterSec], ["blocked_pause", 30 * 60], String(lastCheckAt));
    assert.equal(unknown.verifies(), 0);
  }

  // 쉼 끝이 30분보다 먼 값(시계 바뀜)은 보지 않고 서버 관문에 맡긴다
  const skewed = setup({ storage: { serverOffsetMs: 0, blockDay: "2026-10-27", blockCount: 1, pausedUntil: START + 3 * 3600_000 }, measure: () => rawPage() });
  const skewedReply = await send(skewed.background, checkMessage());
  assert.equal(skewedReply.outcome, "measured");
  assert.equal(skewed.verifies(), 1, "서버 확인은 받는다");
});

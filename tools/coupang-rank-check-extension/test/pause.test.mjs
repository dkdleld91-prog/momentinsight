// 확장 1.0.2 차단 기억(대표 결정 2026-10-27 = 서버 c30-4 와 같은 규칙): 그 날 첫 차단 → 30분 쉼, 같은 날 두 번째 → 그날 중지.
// 가짜 chrome·가짜 fetch 만 쓴다(쿠팡·서버 요청 0번). 시각은 서버 시각(가짜 fetch 의 serverTime)과 같은 시계로 움직인다.
import assert from "node:assert/strict";
import test from "node:test";
import { createBackground } from "../background.js";
import { BLOCKS_PER_DAY_STOP, NOT_STARTED_CODES, PAUSE_MS } from "../lib/protocol.js";
import {
  CHROME_UA, CLAIM_ID, CLAIM_ID_2, CLAIM_ID_3, CLAIM_TOKEN, FAST_TIMING,
  checkMessage, makeFakeChrome, makeFakeFetch, rawPage, send,
} from "./helpers.mjs";

const ZERO_MEASURE = { settleMs: 0, gapMin: 0, gapMax: 0, readGapMs: 0 };
const BLOCKED_403 = () => rawPage({ httpStatus: 403, items: [], blockedText: false, stable: false });
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

test("상수: 30분·두 번째 = 서버 c30-4, 새 시작 못 함 코드 blocked_pause", () => {
  assert.equal(PAUSE_MS, 30 * 60 * 1000);
  assert.equal(BLOCKS_PER_DAY_STOP, 2);
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

test("30분 뒤 허용: 쉼이 끝나면 다시 검색(tabs.update 1번 더) · 같은 날 두 번째 차단 → 그날 중지(blockedDay), 그 뒤 blocked_today", async () => {
  const ctx = setup();
  await checkAndAck(ctx, CLAIM_ID);
  ctx.clock.value = START + PAUSE_MS + 60_000;
  ctx.scenario.value = () => rawPage();
  const ok = await checkAndAck(ctx, CLAIM_ID_2);
  assert.deepEqual([ok.outcome, ok.page.status, ok.stopSignal], ["measured", "ok", false]);
  assert.equal(ctx.fake.calls.update.length, 2);
  assert.equal(ctx.fake.storage.blockCount, 1, "성공은 차단 수를 바꾸지 않는다");
  // 같은 날 두 번째 차단
  ctx.clock.value += 5 * 60_000;
  ctx.scenario.value = () => rawPage({ httpStatus: 429, items: [] });
  const second = await checkAndAck(ctx, CLAIM_ID_3);
  assert.deepEqual([second.stopReason, second.stopReported], ["blocked_http_429", true]);
  const store = ctx.fake.storage;
  assert.deepEqual([store.blockDay, store.blockCount, store.blockedDay], ["2026-10-27", 2, "2026-10-27"]);
  assert.equal(ctx.fake.calls.update.length, 3);
  // 그날은 몇 시간 뒤에도 새 검색 없음
  ctx.clock.value += 3 * 3600_000;
  const today = await send(ctx.background, checkMessage({ claimId: CLAIM_ID }));
  assert.deepEqual([today.code, today.stopReported], ["blocked_today", true]);
  assert.deepEqual([ctx.fake.calls.update.length, ctx.verifies()], [3, 3]);
});

test("다음 날(서버 KST) 초기화: 어제 두 번 차단(그날 중지)이어도 오늘은 검색하고, 오늘 첫 차단은 다시 30분 쉼(blockCount 1)", async () => {
  const ctx = setup({ storage: { serverOffsetMs: 0, blockDay: "2026-10-26", blockCount: 2, blockedDay: "2026-10-26", pausedUntil: START - 20 * 3600_000, stopReportedDay: "2026-10-26" } });
  const reply = await checkAndAck(ctx, CLAIM_ID);
  assert.equal(reply.outcome, "measured");
  assert.equal(ctx.fake.calls.update.length, 1);
  const store = ctx.fake.storage;
  assert.deepEqual([store.blockDay, store.blockCount, store.blockedDay], ["2026-10-27", 1, "2026-10-26"]);
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

test("1.0.1 에서 덮어쓴 날: 1.0.1 이 남긴 blockedDay(오늘)는 그날 중지 그대로(더 엄격한 쪽), 쉼 끝이 30분보다 먼 값(시계 바뀜)은 보지 않고 서버 관문에 맡긴다", async () => {
  const legacy = setup({ storage: { serverOffsetMs: 0, blockedDay: "2026-10-27", stopReportedDay: "2026-10-27" } });
  const refused = await send(legacy.background, checkMessage());
  assert.equal(refused.code, "blocked_today");
  assert.deepEqual([legacy.fake.calls.update.length, legacy.verifies()], [0, 0]);
  const skewed = setup({ storage: { serverOffsetMs: 0, blockDay: "2026-10-27", blockCount: 1, pausedUntil: START + 3 * 3600_000 }, measure: () => rawPage() });
  const measured = await send(skewed.background, checkMessage());
  assert.equal(measured.outcome, "measured");
  assert.equal(skewed.verifies(), 1, "서버 확인은 받는다");
});

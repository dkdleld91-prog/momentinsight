import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDayCells,
  buildSummary,
  collectorState,
  inCollectWindow,
  kstClock,
  kstDayOf,
  kstDays30,
  kstHour,
  nextCheck,
  trackerPayload,
} from "./board.mjs";
import { COLLECTOR_STATES } from "./contract.mjs";

function dayRow(overrides = {}) {
  return {
    tracker_id: "t1",
    kst_day: "2026-10-17",
    slot_minute: 480,
    slot_index: 0,
    result: "found",
    rank: 28,
    organic_count: 50,
    ad_order: 8,
    checked_at: "2026-10-17T02:11:05.000Z",
    success_count: 1,
    failure_count: 0,
    best_rank: 28,
    ...overrides,
  };
}

test("kstDayOf 경계: 14:59:59.999Z 는 그날, 15:00:00.000Z 는 다음 날", () => {
  assert.equal(kstDayOf("2026-10-16T14:59:59.999Z"), "2026-10-16");
  assert.equal(kstDayOf("2026-10-16T15:00:00.000Z"), "2026-10-17");
  assert.equal(kstDayOf("2026-10-16T15:00:00+00:00"), "2026-10-17");
  assert.equal(kstDayOf(""), null);
  assert.equal(kstDayOf("not a date"), null);
});

test("kstDays30 은 서버 now 의 KST 날짜부터 거꾸로 30개, kstClock 은 KST HH:MM", () => {
  const days = kstDays30(new Date("2026-10-16T15:30:00.000Z"));
  assert.equal(days.length, 30);
  assert.equal(days[0], "2026-10-17");
  assert.equal(days[1], "2026-10-16");
  assert.equal(days[29], "2026-09-18");
  assert.equal(new Set(days).size, 30);
  assert.equal(kstClock("2026-10-17T02:11:05.000Z"), "11:11");
  assert.equal(kstClock("2026-10-16T15:00:00.000Z"), "00:00");
  assert.equal(kstClock(null), null);
});

test("KST 시간대 판정은 서버 시간대와 무관하게 Asia/Seoul 시로 한다", () => {
  assert.equal(kstHour(new Date("2026-10-16T22:59:59.000Z")), 7);
  assert.equal(kstHour(new Date("2026-10-16T23:00:00.000Z")), 8);
  assert.equal(kstHour(new Date("2026-10-17T13:59:59.000Z")), 22);
  assert.equal(kstHour(new Date("2026-10-17T14:00:00.000Z")), 23);
  assert.equal(kstHour(new Date("2026-10-16T15:00:00.000Z")), 0);
  const settings = { active_from_hour: 8, active_to_hour: 23 };
  assert.equal(inCollectWindow(settings, new Date("2026-10-16T22:59:59.000Z")), false);
  assert.equal(inCollectWindow(settings, new Date("2026-10-16T23:00:00.000Z")), true);
  assert.equal(inCollectWindow(settings, new Date("2026-10-17T13:59:59.000Z")), true);
  assert.equal(inCollectWindow(settings, new Date("2026-10-17T14:00:00.000Z")), false);
  assert.equal(inCollectWindow({ active_from_hour: 0, active_to_hour: 24 }, new Date("2026-10-16T15:00:00.000Z")), true);
});

test("대표 칸: slot_minute 이 큰 성공 행, 같으면 checked_at 이 늦은 것. c·f 는 합, b 는 최소", () => {
  const cells = buildDayCells([
    dayRow({ slot_minute: 480, slot_index: 0, rank: 25, best_rank: 25, success_count: 1, failure_count: 1, checked_at: "2026-10-16T23:40:00.000Z" }),
    dayRow({ slot_minute: 930, slot_index: 1, rank: 31, best_rank: 31, success_count: 1, failure_count: 0, checked_at: "2026-10-17T07:02:00.000Z", ad_order: null }),
    dayRow({ kst_day: "2026-10-16", slot_minute: 930, slot_index: 1, result: "out", rank: null, best_rank: null, organic_count: 50, ad_order: 3, checked_at: "2026-10-16T08:00:00.000Z" }),
  ]);
  assert.deepEqual(cells, [
    { d: "2026-10-17", s: "found", r: 31, n: 50, a: null, t: "16:02", c: 2, f: 1, b: 25, k: 1 },
    { d: "2026-10-16", s: "out", r: null, n: 50, a: 3, t: "17:00", c: 1, f: 0, b: null, k: 1 },
  ]);
  // 같은 slot_minute 이면 checked_at 이 늦은 것
  const tie = buildDayCells([
    dayRow({ slot_minute: 480, rank: 10, checked_at: "2026-10-17T00:00:00.000Z" }),
    dayRow({ slot_minute: 480, rank: 12, checked_at: "2026-10-17T01:00:00.000Z" }),
  ]);
  assert.equal(tie[0].r, 12);
  // 실패 칸이 slot_minute 이 더 커도 성공 행이 대표
  const mixed = buildDayCells([
    dayRow({ slot_minute: 480, result: "short", rank: null, organic_count: 23 }),
    dayRow({ slot_minute: 930, result: "failed", rank: null, organic_count: null, success_count: 0, failure_count: 3 }),
  ]);
  assert.equal(mixed[0].s, "short");
  assert.equal(mixed[0].n, 23);
  assert.equal(mixed[0].f, 3);
});

test("대표 칸: 성공 행이 없으면 unsupported 가 있을 때 unsupported, 아니면 failed", () => {
  const unsupported = buildDayCells([
    dayRow({ result: "failed", rank: null, best_rank: null, success_count: 0, failure_count: 1, slot_minute: 930 }),
    dayRow({ result: "unsupported", rank: null, best_rank: null, success_count: 0, failure_count: 1, slot_minute: 480, slot_index: 0, checked_at: "2026-10-17T00:30:00.000Z" }),
  ]);
  assert.deepEqual(unsupported[0], { d: "2026-10-17", s: "unsupported", r: null, n: null, a: null, t: "09:30", c: 0, f: 2, b: null, k: 0 });
  const failed = buildDayCells([dayRow({ result: "failed", rank: null, best_rank: null, success_count: 0, failure_count: 2 })]);
  assert.equal(failed[0].s, "failed");
  assert.equal(failed[0].r, null);
  assert.equal(failed[0].f, 2);
});

function trendRows(previous, latest, { previousSlot = 480, latestSlot = 480 } = {}) {
  const rows = [];
  if (previous) rows.push(dayRow({ kst_day: "2026-10-16", slot_minute: previousSlot, ...previous }));
  if (latest) rows.push(dayRow({ kst_day: "2026-10-17", slot_minute: latestSlot, ...latest }));
  return rows;
}

function trendOf(rows) {
  const summary = buildSummary(rows, buildDayCells(rows), null, "ok", kstDays30(new Date("2026-10-17T03:00:00.000Z")));
  return [summary.trend, summary.trendDelta];
}

test("추세 표: 같은 slot_minute 끼리 모든 칸", () => {
  const found = (rank) => ({ result: "found", rank, best_rank: rank });
  const non = (result) => ({ result, rank: null, best_rank: null });
  // L found
  assert.deepEqual(trendOf(trendRows(null, found(10))), ["new", null]);
  assert.deepEqual(trendOf(trendRows(found(13), found(10))), ["up", 3]);
  assert.deepEqual(trendOf(trendRows(found(10), found(15))), ["down", -5]);
  assert.deepEqual(trendOf(trendRows(found(10), found(10))), ["same", 0]);
  for (const result of ["out", "short", "noresult"]) {
    assert.deepEqual(trendOf(trendRows(non(result), found(10))), ["enter", null], result);
  }
  // L out·short·noresult
  for (const result of ["out", "short", "noresult"]) {
    assert.deepEqual(trendOf(trendRows(null, non(result))), ["new", null], result);
    assert.deepEqual(trendOf(trendRows(found(10), non(result))), ["exit", null], result);
    for (const previous of ["out", "short", "noresult"]) {
      assert.deepEqual(trendOf(trendRows(non(previous), non(result))), ["same", null], `${previous}->${result}`);
    }
  }
});

test("추세: slot_minute 이 다르면 비교하지 않는다(P 없음 → new)", () => {
  const rows = trendRows({ result: "found", rank: 30 }, { result: "found", rank: 10 }, { previousSlot: 930, latestSlot: 480 });
  assert.deepEqual(trendOf(rows), ["new", null]);
  // 같은 날의 다른 칸은 P 가 아니다(더 이른 날짜만)
  const sameDay = [
    dayRow({ kst_day: "2026-10-17", slot_minute: 480, rank: 30 }),
    dayRow({ kst_day: "2026-10-17", slot_minute: 930, rank: 10 }),
  ];
  assert.deepEqual(trendOf(sameDay), ["new", null]);
  // L 은 가장 최근 날짜의 가장 큰 slot_minute, P 는 그 칸의 가장 최근 이전 날짜
  const chain = [
    dayRow({ kst_day: "2026-10-15", slot_minute: 930, rank: 40 }),
    dayRow({ kst_day: "2026-10-16", slot_minute: 930, rank: 20 }),
    dayRow({ kst_day: "2026-10-16", slot_minute: 480, rank: 5 }),
    dayRow({ kst_day: "2026-10-17", slot_minute: 930, rank: 25 }),
    dayRow({ kst_day: "2026-10-17", slot_minute: 480, rank: 1 }),
  ];
  assert.deepEqual(trendOf(chain), ["down", -5]);
  // 실패 행은 추세에 쓰지 않는다
  const withFailure = [
    dayRow({ kst_day: "2026-10-16", slot_minute: 480, rank: 20 }),
    dayRow({ kst_day: "2026-10-17", slot_minute: 930, result: "failed", rank: null }),
    dayRow({ kst_day: "2026-10-17", slot_minute: 480, rank: 15 }),
  ];
  assert.deepEqual(trendOf(withFailure), ["up", 5]);
});

test("avg7·best30·foundDays7·measuredDays7", () => {
  const now = new Date("2026-10-17T03:00:00.000Z");
  const days30 = kstDays30(now);
  const rows = [
    dayRow({ kst_day: "2026-10-17", rank: 28, best_rank: 25 }),
    dayRow({ kst_day: "2026-10-16", rank: 27, best_rank: 27 }),
    dayRow({ kst_day: "2026-10-15", result: "out", rank: null, best_rank: null }),
    dayRow({ kst_day: "2026-10-14", result: "failed", rank: null, best_rank: null, success_count: 0, failure_count: 2 }),
    dayRow({ kst_day: "2026-10-10", rank: 40, best_rank: 40 }), // 8일 전: 7일 밖
    dayRow({ kst_day: "2026-09-20", rank: 3, best_rank: 3 }), // 30일 안
    dayRow({ kst_day: "2026-09-10", rank: 1, best_rank: 1 }), // 30일 밖
  ];
  const cells = buildDayCells(rows);
  const summary = buildSummary(rows, cells, null, "ok", days30);
  assert.equal(summary.best30, 3);
  assert.equal(summary.avg7, 27.5);
  assert.equal(summary.foundDays7, 2);
  assert.equal(summary.measuredDays7, 3);
  assert.deepEqual(Object.keys(summary), [
    "best30", "avg7", "foundDays7", "measuredDays7", "trend", "trendDelta", "attention", "attentionReasons", "lastFoundAt",
  ]);
  const thirds = [dayRow({ kst_day: "2026-10-17", rank: 1 }), dayRow({ kst_day: "2026-10-16", rank: 2 }), dayRow({ kst_day: "2026-10-15", rank: 2 })];
  assert.equal(buildSummary(thirds, buildDayCells(thirds), null, "ok", days30).avg7, 1.7);
  assert.equal(buildSummary([], [], null, "ok", days30).avg7, null);
  assert.equal(buildSummary([], [], null, "ok", days30).best30, null);
});

test("attention 4가지", () => {
  const days30 = kstDays30(new Date("2026-10-17T03:00:00.000Z"));
  const summaryOf = (rows, keyword = null, state = "ok") => buildSummary(rows, buildDayCells(rows), keyword, state, days30);
  // drop10: 추세 down 이고 delta ≤ −10
  const drop10 = summaryOf(trendRows({ result: "found", rank: 10 }, { result: "found", rank: 20 }));
  assert.deepEqual(drop10.attentionReasons, ["drop10"]);
  assert.equal(drop10.attention, true);
  const drop9 = summaryOf(trendRows({ result: "found", rank: 10 }, { result: "found", rank: 19 }));
  assert.deepEqual(drop9.attentionReasons, []);
  assert.equal(drop9.attention, false);
  // exit
  assert.deepEqual(summaryOf(trendRows({ result: "found", rank: 10 }, { result: "out", rank: null })).attentionReasons, ["exit"]);
  // 50위 밖 자체는 확인 필요가 아니다(D5)
  assert.deepEqual(summaryOf(trendRows({ result: "out", rank: null }, { result: "out", rank: null })).attentionReasons, []);
  // keyword_failing: 연속 실패 ≥ 3 이고 수집기 상태가 ok·delayed·idle_hours
  const failing = { consecutive_failures: 3, consecutive_unsupported: 0 };
  for (const state of ["ok", "delayed", "idle_hours"]) {
    assert.deepEqual(summaryOf([], failing, state).attentionReasons, ["keyword_failing"], state);
  }
  for (const state of ["offline", "cooldown", "disabled", "not_connected", "review", "budget", "outdated"]) {
    assert.deepEqual(summaryOf([], failing, state).attentionReasons, [], state);
  }
  assert.deepEqual(summaryOf([], { consecutive_failures: 2 }, "ok").attentionReasons, []);
  // unsupported: 연속 이동 ≥ 2
  assert.deepEqual(summaryOf([], { consecutive_unsupported: 2 }, "offline").attentionReasons, ["unsupported"]);
  assert.deepEqual(summaryOf([], { consecutive_unsupported: 1 }, "ok").attentionReasons, []);
  // 여러 사유는 정해진 순서
  const all = summaryOf(trendRows({ result: "found", rank: 10 }, { result: "found", rank: 30 }), { consecutive_failures: 5, consecutive_unsupported: 2 }, "ok");
  assert.deepEqual(all.attentionReasons, ["drop10", "keyword_failing", "unsupported"]);
});

function baseSettings(overrides = {}) {
  return {
    enabled: true,
    needs_owner_review: false,
    budget_blocked: false,
    cooldown_until: null,
    min_collector_version: null,
    active_from_hour: 8,
    active_to_hour: 23,
    ...overrides,
  };
}

test("수집기 상태 11가지와 우선순위", () => {
  const now = new Date("2026-10-17T03:00:00.000Z"); // KST 12:00, 시간대 안
  const night = new Date("2026-10-17T15:00:00.000Z"); // KST 00:00, 시간대 밖
  const fresh = [{ id: "c1", revoked_at: null, last_seen_at: "2026-10-17T02:55:00.000Z", last_version: "1.0.0" }];
  const overdueKeyword = { lease_run_id: null, next_due_at: "2026-10-17T01:30:00.000Z", slot_ends_at: "2026-10-17T06:30:00.000Z" };
  const state = (input) => collectorState({ settings: baseSettings(), collectors: fresh, keywords: [], now, ...input });
  assert.equal(collectorState({ setupRequired: true }), "setup_required");
  assert.equal(state({ collectors: [] }), "not_connected");
  assert.equal(state({ collectors: [{ ...fresh[0], revoked_at: "2026-10-01T00:00:00Z" }] }), "not_connected");
  assert.equal(state({ settings: baseSettings({ enabled: false, needs_owner_review: true }) }), "disabled");
  assert.equal(state({ settings: baseSettings({ needs_owner_review: true, budget_blocked: true }) }), "review");
  assert.equal(state({ settings: baseSettings({ budget_blocked: true, cooldown_until: "2026-10-17T05:00:00Z" }) }), "budget");
  assert.equal(state({ settings: baseSettings({ cooldown_until: "2026-10-17T05:00:00Z", min_collector_version: "9.0.0" }) }), "cooldown");
  // 쉬기 끝난 뒤면 쉬기 아님
  assert.equal(state({ settings: baseSettings({ cooldown_until: "2026-10-17T02:00:00Z" }) }), "ok");
  // outdated: 모든 활성 수집기가 낮을 때만
  assert.equal(state({ settings: baseSettings({ min_collector_version: "1.0.1" }), collectors: [{ ...fresh[0], last_seen_at: null }] }), "outdated");
  assert.equal(state({
    settings: baseSettings({ min_collector_version: "1.0.1" }),
    collectors: [fresh[0], { id: "c2", revoked_at: null, last_seen_at: fresh[0].last_seen_at, last_version: "1.0.1" }],
  }), "ok");
  assert.equal(state({ settings: baseSettings({ min_collector_version: "1.0.0" }) }), "ok");
  assert.equal(state({ settings: baseSettings({ min_collector_version: "1.0.1" }), collectors: [{ ...fresh[0], last_version: null }] }), "outdated");
  // offline: 시간대 안이고 마지막 신호가 없거나 30분 넘음
  assert.equal(state({ collectors: [{ ...fresh[0], last_seen_at: "2026-10-17T02:29:59.000Z" }], keywords: [overdueKeyword] }), "offline");
  assert.equal(state({ collectors: [{ ...fresh[0], last_seen_at: null }] }), "offline");
  assert.equal(state({ collectors: [{ ...fresh[0], last_seen_at: "2026-10-17T02:30:00.000Z" }] }), "ok");
  // 시간대 밖이면 offline 이 아니다
  assert.equal(state({ now: night, collectors: [{ ...fresh[0], last_seen_at: null }] }), "idle_hours");
  // delayed: 임대 없음 + 예정이 60분 넘게 지남 + 칸이 아직 열림
  assert.equal(state({ keywords: [overdueKeyword] }), "delayed");
  assert.equal(state({ keywords: [{ ...overdueKeyword, lease_run_id: "r1" }] }), "ok");
  assert.equal(state({ keywords: [{ ...overdueKeyword, next_due_at: "2026-10-17T02:00:01.000Z" }] }), "ok");
  assert.equal(state({ keywords: [{ ...overdueKeyword, slot_ends_at: "2026-10-17T02:59:00.000Z" }] }), "ok");
  // delayed 는 idle_hours 보다 앞
  assert.equal(state({ now: night, keywords: [{ ...overdueKeyword, next_due_at: "2026-10-17T13:00:00.000Z", slot_ends_at: "2026-10-17T16:00:00.000Z" }] }), "delayed");
  assert.equal(state({ now: night }), "idle_hours");
  assert.equal(state({}), "ok");
  assert.equal(COLLECTOR_STATES.length, 11);
});

test("nextCheckState 4갈래", () => {
  const now = new Date("2026-10-17T03:00:00.000Z");
  const keyword = { next_due_at: "2026-10-17T05:00:00.000Z", slot_ends_at: "2026-10-17T06:30:00.000Z" };
  assert.deepEqual(nextCheck(keyword, "paused", now), { nextCheckAt: null, nextCheckState: "paused" });
  assert.deepEqual(nextCheck(null, "active", now), { nextCheckAt: null, nextCheckState: "replan" });
  assert.deepEqual(nextCheck({ ...keyword, slot_ends_at: null }, "active", now), { nextCheckAt: null, nextCheckState: "replan" });
  assert.deepEqual(nextCheck({ ...keyword, slot_ends_at: "2026-10-17T03:00:00.000Z" }, "active", now), { nextCheckAt: null, nextCheckState: "replan" });
  assert.deepEqual(nextCheck({ ...keyword, next_due_at: "2026-10-17T03:00:00.000Z" }, "active", now), {
    nextCheckAt: "2026-10-17T03:00:00.000Z", nextCheckState: "due",
  });
  assert.deepEqual(nextCheck(keyword, "active", now), { nextCheckAt: "2026-10-17T05:00:00.000Z", nextCheckState: "scheduled" });
});

test("trackerPayload: 필드 순서·days 키·현재값·일시중지 날짜", () => {
  const now = new Date("2026-10-17T03:00:00.000Z");
  const days30 = kstDays30(now);
  const row = {
    id: "t1", agency_code: "mml93-a01", client_id: null, keyword: "아이폰 필름", keyword_key: "아이폰 필름",
    product_id: "8533720933", product_url: "https://www.coupang.com/vp/products/8533720933", vendor_item_id: "96009802650",
    product_title: null, group_name: "기본 그룹", sort_order: 100, status: "paused", paused_at: "2026-10-16T15:10:00.000Z",
    created_kst_day: "2026-10-16", current_result: "found", current_rank: 28, current_organic_count: 50, current_ad_order: 8,
    current_same_option: true, last_checked_at: "2026-10-17T02:11:05.000Z", last_found_at: "2026-10-17T02:11:05.000Z",
    created_at: "2026-10-16T03:00:00.000Z",
  };
  const payload = trackerPayload(row, [dayRow({ tracker_id: "t1" }), dayRow({ kst_day: "2026-09-01" })], null, "ok", days30, now);
  assert.deepEqual(Object.keys(payload), [
    "id", "keyword", "keywordKey", "productId", "productUrl", "vendorItemId", "productTitle", "groupName", "sortOrder",
    "status", "createdAt", "createdDay", "pausedAt", "pausedDay",
    "current", "nextCheckAt", "nextCheckState", "keywordHealth", "summary", "days",
  ]);
  assert.deepEqual(Object.keys(payload.current), ["result", "rank", "organicCount", "adOrder", "sameOption", "checkedAt"]);
  assert.deepEqual(Object.keys(payload.keywordHealth), ["consecutiveFailures", "consecutiveUnsupported", "lastStatus"]);
  assert.equal(payload.pausedDay, "2026-10-17");
  assert.equal(payload.createdDay, "2026-10-16");
  assert.equal(payload.nextCheckState, "paused");
  // 30일 밖 행은 빠진다
  assert.equal(payload.days.length, 1);
  assert.deepEqual(Object.keys(payload.days[0]), ["d", "s", "r", "n", "a", "t", "c", "f", "b", "k"]);
  assert.equal(payload.summary.lastFoundAt, "2026-10-17T02:11:05.000Z");
  const fresh = trackerPayload({ ...row, status: "active", paused_at: null, current_result: null, created_kst_day: null }, [], null, "ok", days30, now);
  assert.equal(fresh.current, null);
  assert.equal(fresh.pausedDay, null);
  assert.equal(fresh.createdDay, "2026-10-16");
  assert.equal(fresh.nextCheckState, "replan");
  assert.deepEqual(fresh.days, []);
  assert.deepEqual(fresh.keywordHealth, { consecutiveFailures: 0, consecutiveUnsupported: 0, lastStatus: null });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  EDITABLE_SETTING_FIELDS,
  capacityOf,
  isRaisingPatch,
  nextLadderStep,
  raiseStatus,
  settingsPayload,
  validateSettingsPatch,
} from "./settings.mjs";

const NOW = new Date("2026-10-20T03:00:00.000Z");
const QUIET = "2026-10-18T02:00:00.000Z"; // 49시간 전
const RECENT = "2026-10-19T03:00:00.000Z"; // 24시간 전
const CALM_STATS = Object.freeze({ blocked48h: 0, empty48h: 0, success48h: 48 });

function settingsRow(overrides = {}) {
  return {
    id: 1,
    enabled: false,
    team_access_enabled: false,
    client_view_enabled: false,
    checks_per_day: 2,
    min_gap_seconds: 240,
    gap_jitter_seconds: 120,
    max_runs_per_hour: 12,
    max_runs_per_day: 120,
    active_from_hour: 8,
    active_to_hour: 23,
    default_account_limit: 20,
    global_keyword_limit: 150,
    window_mode: "offscreen",
    min_collector_version: null,
    max_storage_mb: 60,
    db_size_stop_mb: 450,
    cooldown_until: null,
    cooldown_reason: null,
    needs_owner_review: false,
    review_reason: null,
    budget_blocked: false,
    budget_reason: null,
    error_streak: 0,
    empty_streak: 0,
    rate_changed_at: QUIET,
    updated_at: "2026-10-18T02:00:00.000Z",
    updated_by: null,
    ...overrides,
  };
}

test("settingsPayload: §5.6 settings 필드 순서·camelCase", () => {
  const payload = settingsPayload(settingsRow());
  assert.deepEqual(Object.keys(payload), [
    "enabled", "teamAccessEnabled", "clientViewEnabled", "checksPerDay", "minGapSeconds", "gapJitterSeconds",
    "maxRunsPerHour", "maxRunsPerDay", "activeFromHour", "activeToHour", "defaultAccountLimit", "globalKeywordLimit",
    "windowMode", "minCollectorVersion", "maxStorageMb", "dbSizeStopMb", "cooldownUntil", "cooldownReason",
    "needsOwnerReview", "reviewReason", "budgetBlocked", "budgetReason", "rateChangedAt", "updatedAt",
    "manualEnabled", "manualMinGapSeconds", "manualMaxPerDay", "manualFromHour", "manualToHour",
    "manualStoppedDay", "manualStoppedAt", "manualStoppedCode",
  ]);
  assert.equal(payload.maxRunsPerHour, 12);
  assert.equal(payload.windowMode, "offscreen");
  // 내부 상태 열(error_streak 등)은 내보내지 않는다
  assert.equal(Object.hasOwn(payload, "errorStreak"), false);
});

test("검증: 편집 가능한 칸의 범위 경계", () => {
  const current = settingsRow();
  const cases = [
    ["teamAccessEnabled", true, false], ["teamAccessEnabled", "true", true],
    ["clientViewEnabled", false, false], ["clientViewEnabled", 1, true],
    ["checksPerDay", 1, false], ["checksPerDay", 6, false], ["checksPerDay", 0, true], ["checksPerDay", 7, true], ["checksPerDay", 2.5, true],
    ["minGapSeconds", 3600, false], ["minGapSeconds", 3601, true], ["minGapSeconds", 29, true],
    ["gapJitterSeconds", 0, false], ["gapJitterSeconds", 600, false], ["gapJitterSeconds", 601, true], ["gapJitterSeconds", -1, true],
    ["maxRunsPerHour", 1, false], ["maxRunsPerHour", 0, true], ["maxRunsPerHour", 61, true],
    ["maxRunsPerDay", 1, false], ["maxRunsPerDay", 0, true], ["maxRunsPerDay", 1001, true],
    ["activeFromHour", 0, false], ["activeFromHour", 24, true], ["activeFromHour", -1, true],
    ["activeToHour", 24, false], ["activeToHour", 0, true], ["activeToHour", 25, true],
    ["defaultAccountLimit", 0, false], ["defaultAccountLimit", 1000, false], ["defaultAccountLimit", 1001, true],
    ["globalKeywordLimit", 1, false], ["globalKeywordLimit", 0, true], ["globalKeywordLimit", 1001, true],
    ["windowMode", "normal", false], ["windowMode", "minimized", false], ["windowMode", "hidden", true],
    ["minCollectorVersion", null, false], ["minCollectorVersion", "1.2.3", false], ["minCollectorVersion", "1.2", true], ["minCollectorVersion", "v1.2.3", true],
    ["maxStorageMb", 10, false], ["maxStorageMb", 400, false], ["maxStorageMb", 9, true], ["maxStorageMb", 401, true],
    ["dbSizeStopMb", 100, false], ["dbSizeStopMb", 8000, false], ["dbSizeStopMb", 99, true], ["dbSizeStopMb", 8001, true],
  ];
  for (const [field, value, rejected] of cases) {
    const result = validateSettingsPatch({ [field]: value }, current, CALM_STATS, NOW, true);
    if (rejected) {
      assert.equal(result.ok, false, `${field}=${JSON.stringify(value)}`);
      assert.equal(result.status, 400);
      assert.equal(result.code, "COUPANG_SETTINGS_INVALID");
      assert.equal(result.field, field);
    } else {
      assert.equal(result.ok, true, `${field}=${JSON.stringify(value)} ${JSON.stringify(result)}`);
    }
  }
  // activeToHour 24 는 from < to 일 때 허용(0~24시)
  assert.equal(validateSettingsPatch({ activeFromHour: 0, activeToHour: 24 }, current, CALM_STATS, NOW, true).ok, true);
  // 숫자 문자열은 정수로 읽는다(화면 폼 값)
  assert.deepEqual(validateSettingsPatch({ checksPerDay: "3" }, current, null, NOW).update, { checks_per_day: 3 });
});

test("검증: 모르는 칸·빈 패치·from ≥ to 는 SETTINGS_INVALID {field}", () => {
  const current = settingsRow();
  assert.deepEqual(validateSettingsPatch({ enabled: true }, current, null, NOW), {
    ok: false, status: 400, code: "COUPANG_SETTINGS_INVALID", field: "enabled",
  });
  assert.equal(validateSettingsPatch({ cooldownUntil: null }, current, null, NOW).field, "cooldownUntil");
  assert.equal(validateSettingsPatch({ __proto__x: 1 }, current, null, NOW).field, "__proto__x");
  assert.equal(validateSettingsPatch({}, current, null, NOW).field, "settings");
  assert.equal(validateSettingsPatch(null, current, null, NOW).field, "settings");
  assert.equal(validateSettingsPatch([1], current, null, NOW).field, "settings");
  assert.equal(validateSettingsPatch({ activeFromHour: 23 }, current, null, NOW).field, "activeFromHour");
  assert.equal(validateSettingsPatch({ activeToHour: 8 }, current, null, NOW).field, "activeToHour");
  assert.equal(validateSettingsPatch({ activeFromHour: 10, activeToHour: 10 }, current, null, NOW).field, "activeFromHour");
  assert.deepEqual(EDITABLE_SETTING_FIELDS.length, 16);
});

test("내리는 변경은 확인·집계 없이 바로 되고 rate_changed_at 은 그대로", () => {
  const current = settingsRow({ rate_changed_at: RECENT });
  const lowered = validateSettingsPatch({ maxRunsPerHour: 6, maxRunsPerDay: 90, minGapSeconds: 300, activeFromHour: 9, activeToHour: 22 }, current, null, NOW);
  assert.equal(lowered.ok, true);
  assert.equal(lowered.raise, false);
  assert.deepEqual(lowered.update, {
    max_runs_per_hour: 6, max_runs_per_day: 90, min_gap_seconds: 300, active_from_hour: 9, active_to_hour: 22,
  });
  assert.equal(Object.hasOwn(lowered.update, "rate_changed_at"), false);
  assert.equal(isRaisingPatch({ maxRunsPerHour: 6 }, current), false);
  // 같은 값은 상향이 아니다
  assert.equal(validateSettingsPatch({ maxRunsPerHour: 12 }, current, null, NOW).ok, true);
});

test("상향 판정: 시간당·하루 증가, 최소 간격 감소, 시간대 넓힘(한쪽이라도)", () => {
  const current = settingsRow();
  assert.equal(isRaisingPatch({ maxRunsPerHour: 24 }, current), true);
  assert.equal(isRaisingPatch({ maxRunsPerDay: 121 }, current), true);
  assert.equal(isRaisingPatch({ minGapSeconds: 239 }, current), true);
  assert.equal(isRaisingPatch({ activeFromHour: 7 }, current), true);
  assert.equal(isRaisingPatch({ activeToHour: 24 }, current), true);
  assert.equal(isRaisingPatch({ activeFromHour: 7, activeToHour: 22 }, current), true);
  assert.equal(isRaisingPatch({ gapJitterSeconds: 0 }, current), false);
  assert.equal(isRaisingPatch({ checksPerDay: 6 }, current), false);
  assert.equal(isRaisingPatch({ windowMode: "normal" }, current), false);
});

test("상향 4조건 각각", () => {
  const current = settingsRow();
  // 1. 확인 없음 → 400
  const unconfirmed = validateSettingsPatch({ maxRunsPerHour: 24 }, current, CALM_STATS, NOW, false);
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.code, "COUPANG_RAISE_CONFIRM_REQUIRED");
  // 모두 통과 → rate_changed_at = now
  const passed = validateSettingsPatch({ maxRunsPerHour: 24 }, current, CALM_STATS, NOW, true);
  assert.equal(passed.ok, true);
  assert.equal(passed.raise, true);
  assert.equal(passed.update.rate_changed_at, NOW.toISOString());
  // 2. 차단·빈 쪽·성공 수
  for (const [stats, reason] of [
    [{ ...CALM_STATS, blocked48h: 1 }, "blocked_or_empty_48h"],
    [{ ...CALM_STATS, empty48h: 2 }, "blocked_or_empty_48h"],
    [{ ...CALM_STATS, success48h: 47 }, "too_few_success_48h"],
  ]) {
    const result = validateSettingsPatch({ maxRunsPerHour: 24 }, current, stats, NOW, true);
    assert.equal(result.status, 409);
    assert.equal(result.code, "COUPANG_RAISE_NOT_ALLOWED");
    assert.deepEqual(result.reasons, [reason]);
    assert.equal(result.nextStep, 24);
    assert.equal(result.hoursSinceRateChange, 49);
    for (const key of ["blocked48h", "empty48h", "success48h"]) assert.equal(result[key], stats[key]);
  }
  // 집계를 못 읽었으면(없음) 통과시키지 않는다
  assert.deepEqual(validateSettingsPatch({ maxRunsPerDay: 200 }, current, null, NOW, true).reasons, [
    "blocked_or_empty_48h", "too_few_success_48h",
  ]);
  // 3. 마지막 상향 뒤 48시간
  const recent = validateSettingsPatch({ maxRunsPerHour: 24 }, settingsRow({ rate_changed_at: RECENT }), CALM_STATS, NOW, true);
  assert.deepEqual(recent.reasons, ["quiet_window_short"]);
  assert.equal(recent.hoursSinceRateChange, 24);
  const edge = validateSettingsPatch({ maxRunsPerHour: 24 }, settingsRow({ rate_changed_at: "2026-10-18T03:00:00.000Z" }), CALM_STATS, NOW, true);
  assert.equal(edge.ok, true, "정확히 48시간이면 통과");
  // 4. 사다리: 바로 다음 값만
  assert.deepEqual(validateSettingsPatch({ maxRunsPerHour: 40 }, current, CALM_STATS, NOW, true).reasons, ["ladder_step"]);
  assert.deepEqual(validateSettingsPatch({ maxRunsPerHour: 13 }, current, CALM_STATS, NOW, true).reasons, ["ladder_step"]);
  // 여러 조건이 한꺼번에 어긋나면 모두 담는다
  assert.deepEqual(validateSettingsPatch({ maxRunsPerHour: 60 }, settingsRow({ rate_changed_at: RECENT }), { blocked48h: 1, empty48h: 0, success48h: 0 }, NOW, true).reasons, [
    "blocked_or_empty_48h", "too_few_success_48h", "quiet_window_short", "ladder_step",
  ]);
  // 시간당이 아닌 상향(하루·간격·시간대)은 사다리와 무관
  assert.equal(validateSettingsPatch({ maxRunsPerDay: 500, minGapSeconds: 60, activeFromHour: 0, activeToHour: 24 }, current, CALM_STATS, NOW, true).ok, true);
});

test("사다리: 12→24→40→60, 사다리 밖 값은 그보다 큰 가장 작은 단계(6→12 포함)", () => {
  assert.equal(nextLadderStep(6), 12);
  assert.equal(nextLadderStep(12), 24);
  assert.equal(nextLadderStep(20), 24);
  assert.equal(nextLadderStep(24), 40);
  assert.equal(nextLadderStep(40), 60);
  assert.equal(nextLadderStep(60), null);
  const six = settingsRow({ max_runs_per_hour: 6 });
  assert.equal(validateSettingsPatch({ maxRunsPerHour: 12 }, six, CALM_STATS, NOW, true).ok, true);
  assert.deepEqual(validateSettingsPatch({ maxRunsPerHour: 7 }, six, CALM_STATS, NOW, true).reasons, ["ladder_step"]);
  assert.deepEqual(validateSettingsPatch({ maxRunsPerHour: 24 }, six, CALM_STATS, NOW, true).reasons, ["ladder_step"]);
  // 60 에서는 하루 상한은 올릴 수 있다
  assert.equal(validateSettingsPatch({ maxRunsPerDay: 1000 }, settingsRow({ max_runs_per_hour: 60 }), CALM_STATS, NOW, true).ok, true);
});

test("replan: 하루 횟수나 시간대가 실제로 바뀔 때만", () => {
  const current = settingsRow();
  assert.equal(validateSettingsPatch({ checksPerDay: 3 }, current, null, NOW).replan, true);
  assert.equal(validateSettingsPatch({ checksPerDay: 2 }, current, null, NOW).replan, false);
  assert.equal(validateSettingsPatch({ activeToHour: 22 }, current, null, NOW).replan, true);
  assert.equal(validateSettingsPatch({ activeFromHour: 8 }, current, null, NOW).replan, false);
  assert.equal(validateSettingsPatch({ maxRunsPerHour: 6, windowMode: "normal" }, current, null, NOW).replan, false);
});

test("raiseStatus: 패널 버튼용 판정", () => {
  assert.deepEqual(raiseStatus(settingsRow(), CALM_STATS, NOW), {
    allowed: true, nextStep: 24, reasons: [], blocked48h: 0, empty48h: 0, success48h: 48, hoursSinceRateChange: 49,
  });
  assert.deepEqual(raiseStatus(settingsRow({ rate_changed_at: RECENT }), CALM_STATS, NOW).reasons, ["quiet_window_short"]);
  assert.deepEqual(raiseStatus(settingsRow({ max_runs_per_hour: 60 }), CALM_STATS, NOW).reasons, ["ladder_step"]);
  assert.equal(raiseStatus(settingsRow(), {}, NOW).allowed, false);
});

test("capacityOf", () => {
  // 시간당 12 × 15시간 = 180, 하루 상한 120 → 120. 하루 2회 → 60
  assert.deepEqual(capacityOf(settingsRow(), 41), { runsPerDay: 120, keywordsAtChecks: 60, activeKeywords: 41, over: false });
  assert.deepEqual(capacityOf(settingsRow(), 61), { runsPerDay: 120, keywordsAtChecks: 60, activeKeywords: 61, over: true });
  // 시간당 6 × 15시간 = 90 → 하루 2회면 45(§1 D3 근거)
  assert.equal(capacityOf(settingsRow({ max_runs_per_hour: 6 })).keywordsAtChecks, 45);
  assert.equal(capacityOf(settingsRow({ checks_per_day: 3 }), 40).keywordsAtChecks, 40);
  assert.equal(capacityOf(settingsRow({ checks_per_day: 3 }), 40).over, false);
  assert.deepEqual(capacityOf(settingsRow()), { runsPerDay: 120, keywordsAtChecks: 60, activeKeywords: null, over: false });
  assert.equal(capacityOf(settingsRow({ max_runs_per_day: 1000, max_runs_per_hour: 60, active_from_hour: 0, active_to_hour: 24, checks_per_day: 1 })).keywordsAtChecks, 1000);
});

// ── ① 지금 확인(spec-manual §6.9) ──

test("settingsPayload: 수동 칸이 없으면(대표 SQL 전) false/null, 있으면 그대로 옮긴다", () => {
  const before = settingsPayload(settingsRow());
  assert.deepEqual(
    [before.manualEnabled, before.manualMinGapSeconds, before.manualMaxPerDay, before.manualFromHour, before.manualToHour,
      before.manualStoppedDay, before.manualStoppedAt, before.manualStoppedCode],
    [false, null, null, null, null, null, null, null],
  );
  const after = settingsPayload(settingsRow({
    manual_enabled: true, manual_min_gap_seconds: 180, manual_max_per_day: 30, manual_from_hour: 9, manual_to_hour: 19,
    manual_stopped_day: "2026-10-20", manual_stopped_at: "2026-10-20T02:00:00.000Z", manual_stopped_code: "blocked_http_403",
  }));
  assert.deepEqual(
    [after.manualEnabled, after.manualMinGapSeconds, after.manualMaxPerDay, after.manualFromHour, after.manualToHour,
      after.manualStoppedDay, after.manualStoppedAt, after.manualStoppedCode],
    [true, 180, 30, 9, 19, "2026-10-20", "2026-10-20T02:00:00.000Z", "blocked_http_403"],
  );
});

test("manualEnabled: boolean 만, 상향·재계획이 아니고, 간격·하루·시간 수동 칸은 화면에서 바꿀 수 없다", () => {
  const current = settingsRow({ rate_changed_at: RECENT });
  const on = validateSettingsPatch({ manualEnabled: true }, current, null, NOW);
  assert.deepEqual(on, { ok: true, update: { manual_enabled: true }, raise: false, replan: false });
  assert.equal(isRaisingPatch({ manualEnabled: true }, current), false);
  assert.deepEqual(validateSettingsPatch({ manualEnabled: false }, current, null, NOW).update, { manual_enabled: false });
  for (const value of ["true", 1, null]) {
    assert.equal(validateSettingsPatch({ manualEnabled: value }, current, null, NOW).field, "manualEnabled", JSON.stringify(value));
  }
  for (const field of ["manualMinGapSeconds", "manualMaxPerDay", "manualFromHour", "manualToHour", "manualStoppedDay"]) {
    assert.equal(validateSettingsPatch({ [field]: 1 }, current, null, NOW).field, field);
  }
  assert.ok(EDITABLE_SETTING_FIELDS.includes("manualEnabled"));
});

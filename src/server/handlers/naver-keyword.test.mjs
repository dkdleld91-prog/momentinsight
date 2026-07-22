import assert from "node:assert/strict";
import test from "node:test";

import { shoppingAgeProfile } from "./naver-keyword.mjs";

function agePayload(data) {
  return { results: [{ data }] };
}

test("연령 비중은 비교 가능한 최신 완료 월만 사용하고 진행 중인 월은 제외한다", () => {
  const profile = shoppingAgeProfile(agePayload([
    { period: "2026-06-01", group: "10", ratio: 5 },
    { period: "2026-06-01", group: "20", ratio: 20 },
    { period: "2026-06-01", group: "30", ratio: 40 },
    { period: "2026-06-01", group: "40", ratio: 20 },
    { period: "2026-06-01", group: "50", ratio: 10 },
    { period: "2026-06-01", group: "60", ratio: 5 },
    { period: "2026-07-01", group: "10", ratio: 1 },
    { period: "2026-07-01", group: "20", ratio: 1 },
    { period: "2026-07-01", group: "30", ratio: 1 },
    { period: "2026-07-01", group: "40", ratio: 1 },
    { period: "2026-07-01", group: "50", ratio: 100 },
    { period: "2026-07-01", group: "60", ratio: 100 },
  ]), "2026-07-21");

  assert.deepEqual(profile, {
    period: "2026-06-01",
    shares: [5, 20, 40, 20, 15],
  });
});

test("응답에서 빠진 0값 연령대는 오류가 아니라 0%로 처리한다", () => {
  const profile = shoppingAgeProfile(agePayload([
    { period: "2026-06-01", group: "20", ratio: 20 },
    { period: "2026-06-01", group: "30", ratio: 30 },
    { period: "2026-06-01", group: "40", ratio: 40 },
    { period: "2026-06-01", group: "50", ratio: 10 },
  ]), "2026-07-21");

  assert.deepEqual(profile, {
    period: "2026-06-01",
    shares: [0, 20, 30, 40, 10],
  });
  assert.equal(profile.shares.reduce((sum, value) => sum + value, 0), 100);
});

test("조회 종료일이 월말이면 해당 월을 완료 월로 사용할 수 있다", () => {
  const profile = shoppingAgeProfile(agePayload([
    { period: "2026-07-01", group: "10", ratio: 10 },
    { period: "2026-07-01", group: "20", ratio: 20 },
    { period: "2026-07-01", group: "30", ratio: 30 },
    { period: "2026-07-01", group: "40", ratio: 20 },
    { period: "2026-07-01", group: "50", ratio: 10 },
    { period: "2026-07-01", group: "60", ratio: 10 },
  ]), "2026-07-31");

  assert.deepEqual(profile, {
    period: "2026-07-01",
    shares: [10, 20, 30, 20, 20],
  });
});

test("완료된 연령 데이터가 없으면 비율을 만들어내지 않는다", () => {
  const profile = shoppingAgeProfile(agePayload([
    { period: "2026-07-01", group: "40", ratio: 100 },
  ]), "2026-07-21");

  assert.equal(profile, null);
});

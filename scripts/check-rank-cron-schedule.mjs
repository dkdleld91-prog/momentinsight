import assert from "node:assert/strict";
import { nextRankCheckAt } from "../src/server/handlers/naver-rank-trackers.mjs";

function kstDate(year, month, day, hour, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0));
}

function kstStamp(iso) {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const cases = [
  ["Saturday before morning slot", kstDate(2026, 6, 27, 8, 58), "2026-06-27 09:00"],
  ["Saturday before afternoon slot", kstDate(2026, 6, 27, 9, 10), "2026-06-27 15:00"],
  ["Saturday after afternoon slot", kstDate(2026, 6, 27, 15, 10), "2026-06-28 09:00"],
  ["Sunday before morning slot", kstDate(2026, 6, 28, 8, 58), "2026-06-28 09:00"],
  ["Sunday after morning slot", kstDate(2026, 6, 28, 9, 10), "2026-06-28 15:00"],
  ["Sunday after afternoon slot", kstDate(2026, 6, 28, 15, 10), "2026-06-29 09:00"],
];

for (const [label, input, expected] of cases) {
  assert.equal(kstStamp(nextRankCheckAt(input)), expected, label);
}

console.log("Rank cron schedule checks passed.");

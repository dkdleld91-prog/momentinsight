import assert from "node:assert/strict";
import fs from "node:fs";
import { nextRankCheckAt } from "../src/server/handlers/naver-rank-trackers.mjs";
import { nextPlaceRankCheckAt } from "../src/server/handlers/naver-place-rank-trackers.mjs";

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

const dailySlots = [
  ["Monday", 2026, 6, 22, "2026-06-22", "2026-06-23"],
  ["Tuesday", 2026, 6, 23, "2026-06-23", "2026-06-24"],
  ["Wednesday", 2026, 6, 24, "2026-06-24", "2026-06-25"],
  ["Thursday", 2026, 6, 25, "2026-06-25", "2026-06-26"],
  ["Friday", 2026, 6, 26, "2026-06-26", "2026-06-27"],
  ["Saturday", 2026, 6, 27, "2026-06-27", "2026-06-28"],
  ["Sunday", 2026, 6, 28, "2026-06-28", "2026-06-29"],
];

const cases = dailySlots.flatMap(([weekday, year, month, day, today, tomorrow]) => [
  [`${weekday} before morning slot`, kstDate(year, month, day, 8, 58), `${today} 09:00`],
  [`${weekday} before afternoon slot`, kstDate(year, month, day, 9, 10), `${today} 15:00`],
  [`${weekday} after afternoon slot`, kstDate(year, month, day, 15, 10), `${tomorrow} 09:00`],
]);

for (const [label, input, expected] of cases) {
  assert.equal(kstStamp(nextRankCheckAt(input)), expected, label);
  assert.equal(kstStamp(nextPlaceRankCheckAt(input)), expected, `Naver place ${label}`);
}

const workflow = fs.readFileSync(".github/workflows/naver-rank-cron.yml", "utf8");
assert.match(workflow, /cron: "0,5,10,15 0,6 \* \* \*"/, "GitHub Actions must retry the 09:00/15:00 KST slots");
assert.match(workflow, /cron: "37 \* \* \* \*"/, "GitHub Actions must keep an hourly catch-up run");
assert.match(workflow, /KST 09:00\/15:00 rescue window/, "Workflow must document the rescue-window behavior");
assert.match(workflow, /Hourly catch-up keeps due trackers moving/, "Workflow must document missed-slot catch-up behavior");

const placeWorkflow = fs.readFileSync(".github/workflows/naver-place-rank-cron.yml", "utf8");
assert.match(placeWorkflow, /cron: "0,5,10,15 0,6 \* \* \*"/, "Naver place workflow must retry the 09:00/15:00 KST slots");
assert.match(placeWorkflow, /cron: "37 \* \* \* \*"/, "Naver place workflow must keep an hourly catch-up run");
assert.match(placeWorkflow, /Hourly catch-up drains delayed or retried trackers/, "Naver place workflow must document missed-slot catch-up behavior");
assert.match(placeWorkflow, /timeout-minutes: 30/, "Naver place workflow must allow enough time for sequential collector calls");
assert.match(placeWorkflow, /Push-triggered deploy backfill/, "Naver place workflow must backfill due trackers after deployment");

const vercelConfig = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
assert.ok(
  (vercelConfig.crons || []).some((cron) => cron.path === "/api/naver-rank-cron" && cron.schedule === "7 0 * * *"),
  "Vercel backup cron must run once daily at 09:07 KST",
);

console.log("Daily rank cron schedule checks passed.");

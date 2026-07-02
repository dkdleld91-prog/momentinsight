import assert from "node:assert/strict";
import fs from "node:fs";
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
}

const workflow = fs.readFileSync(".github/workflows/naver-rank-cron.yml", "utf8");
assert.match(workflow, /cron: "7,37 \* \* \* \*"/, "GitHub Actions must catch up due trackers every 30 minutes");
assert.match(workflow, /missed 09:00\/15:00 KST slots are caught up automatically/, "Workflow must document missed-slot catch-up behavior");

const vercelConfig = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
assert.ok(
  (vercelConfig.crons || []).some((cron) => cron.path === "/api/naver-rank-cron" && cron.schedule === "7 0 * * *"),
  "Vercel backup cron must run once daily at 09:07 KST",
);

console.log("Daily rank cron schedule checks passed.");

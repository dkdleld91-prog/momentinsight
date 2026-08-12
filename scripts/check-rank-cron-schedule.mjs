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
assert.match(workflow, /cron: "5,10,15 0,6 \* \* \*"/, "GitHub Actions must let the local worker start before rescue retries");
assert.match(workflow, /cron: "37 \* \* \* \*"/, "GitHub Actions must keep an hourly catch-up run");
assert.match(workflow, /durable-cycle wake window/, "Workflow must document the durable-cycle wake behavior");
assert.match(workflow, /Hourly catch-up wakes the same cycle/, "Workflow must document missed-slot catch-up behavior");
assert.match(workflow, /timeout-minutes: 180/, "Product workflow must cover one hundred bounded sequential calls");
assert.match(workflow, /const batchSize = 1;/, "Product workflow must keep each request within the mobile fallback rate envelope");
assert.match(workflow, /const maxBatches = 100;/, "Product workflow must keep its explicit 100-tracker window cap");
assert.match(workflow, /drain 100 due trackers/, "Product workflow must document its bounded window capacity");
assert.match(workflow, /await sleep\(8000\)/, "Product workflow must pace mobile fallback requests by eight seconds");
assert.match(workflow, /preserved/, "Product workflow must account for safely preserved rows separately");
assert.doesNotMatch(workflow, /\n\s*push:/, "Product workflow must not race a failed or incomplete production deployment");
assert.match(workflow, /const requestTimeoutMs = 285000;/, "Product workflow must bound each server call below the function ceiling");
assert.match(workflow, /searchParams\.set\("mode", "drain"\)/, "Product workflow must identify the bounded queue-drain caller");
assert.match(workflow, /before the queue reported drained/, "Product workflow must fail when its cap is reached before drain confirmation");
assert.match(workflow, /safe\.drained !== \(safe\.remaining === 0\)/, "Product workflow must cross-check queue drain state");
assert.match(workflow, /safe\.checked === 0 && !safe\.drained/, "Product workflow must reject a zero-progress non-drained batch");
assert.match(workflow, /!safe\.configured/, "Product workflow must fail when the rank provider is unavailable");
assert.match(workflow, /const itemFailureResponse = response\.status === 502/, "Product workflow must parse bounded item failures before rejecting the transport");
assert.match(workflow, /payloadCode === "NAVER_RANK_CRON_ITEM_FAILURE"/, "Product workflow must accept only the typed item-failure response");
assert.match(workflow, /payloadCode === "NAVER_RANK_PROVIDER_NOT_CONFIGURED"/, "Product workflow must recognize the typed provider configuration failure");
assert.match(workflow, /totals\.failed > 0/, "Product workflow must report tracker failures after draining the remaining queue");
assert.match(workflow, /drained the queue with/, "Product workflow must surface a degraded drained run as failed");

const placeWorkflow = fs.readFileSync(".github/workflows/naver-place-rank-cron.yml", "utf8");
assert.match(placeWorkflow, /cron: "0,5,10,15 0,6 \* \* \*"/, "Naver place workflow must retry the 09:00/15:00 KST slots");
assert.match(placeWorkflow, /cron: "37 \* \* \* \*"/, "Naver place workflow must keep an hourly catch-up run");
assert.match(placeWorkflow, /Hourly catch-up drains delayed or retried trackers/, "Naver place workflow must document missed-slot catch-up behavior");
assert.match(placeWorkflow, /timeout-minutes: 100/, "Naver place workflow must cover twenty bounded sequential collector calls");
assert.match(placeWorkflow, /const maxBatches = 20;/, "Naver place workflow must keep its explicit safety cap");
assert.match(placeWorkflow, /const requestTimeoutMs = 260000;/, "Naver place workflow must bound each collector call");
assert.match(placeWorkflow, /searchParams\.set\("mode", "drain"\)/, "Naver place workflow must identify the bounded queue-drain caller");
assert.match(placeWorkflow, /before the queue reported drained/, "Naver place workflow must fail when its cap is reached before drain confirmation");
assert.match(placeWorkflow, /safe\.drained !== \(safe\.remaining === 0\)/, "Naver place workflow must cross-check queue drain state");
assert.match(placeWorkflow, /safe\.checked === 0 && !safe\.drained/, "Naver place workflow must reject a zero-progress non-drained batch");
assert.match(placeWorkflow, /totals\.partial > 0/, "Naver place workflow must surface partial lookups as a degraded run");
assert.match(placeWorkflow, /Push-triggered deploy backfill/, "Naver place workflow must backfill due trackers after deployment");

const vercelConfig = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
assert.ok(
  (vercelConfig.crons || []).some((cron) => cron.path === "/api/naver-rank-cron" && cron.schedule === "7 0 * * *"),
  "Vercel backup cron must run once daily at 09:07 KST",
);

console.log("Daily rank cron schedule checks passed.");

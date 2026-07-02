import assert from "node:assert/strict";
import {
  estimateMonthlySearchSeries,
  latestCompleteTrendIndex,
  trendLabels,
} from "../src/server/handlers/naver-keyword.mjs";

const partialCurrentMonthTrend = {
  results: [
    {
      data: [
        { period: "2026-05-01", ratio: 78.3 },
        { period: "2026-06-01", ratio: 100 },
        { period: "2026-07-01", ratio: 3.35 },
      ],
    },
  ],
};

const anchorIndex = latestCompleteTrendIndex(partialCurrentMonthTrend, "2026-07-01");
assert.equal(anchorIndex, 1, "current partial month must not be used as the search volume anchor");

const series = estimateMonthlySearchSeries([78.3, 100, 3.35], 81200, anchorIndex);
assert.deepEqual(series, [63580, 81200, 2720]);
assert.ok(Math.max(...series) < 100000, "series should not inflate into million-scale values");

assert.deepEqual(
  trendLabels(partialCurrentMonthTrend, "2026-07-01"),
  ["05월", "06월", "07월(예상)"],
);

const completeMonthTrend = {
  results: [
    {
      data: [
        { period: "2026-05-01", ratio: 80 },
        { period: "2026-06-01", ratio: 100 },
      ],
    },
  ],
};

assert.equal(latestCompleteTrendIndex(completeMonthTrend, "2026-06-30"), 1);
assert.deepEqual(trendLabels(completeMonthTrend, "2026-06-30"), ["05월", "06월"]);

console.log("keyword trend scaling check passed");

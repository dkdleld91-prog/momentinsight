import assert from "node:assert/strict";
import test from "node:test";

import {
  latestLocalWorkerSlotAt,
  localWorkerCatchupRequired,
  nextLocalWorkerSlotAt,
  nextLocalWorkerWakeAt,
} from "./local-worker-schedule.mjs";

test("keeps the existing 09:00 and 15:00 KST slots", () => {
  assert.equal(nextLocalWorkerSlotAt(new Date("2026-08-01T23:59:00.000Z")), "2026-08-02T00:00:00.000Z");
  assert.equal(nextLocalWorkerSlotAt(new Date("2026-08-02T00:00:00.000Z")), "2026-08-02T06:00:00.000Z");
  assert.equal(nextLocalWorkerSlotAt(new Date("2026-08-02T06:00:00.000Z")), "2026-08-03T00:00:00.000Z");
});

test("schedules a wake ten minutes before each KST run", () => {
  assert.equal(nextLocalWorkerWakeAt(new Date("2026-08-01T23:00:00.000Z")), "2026-08-01T23:50:00.000Z");
  assert.equal(nextLocalWorkerWakeAt(new Date("2026-08-01T23:50:00.000Z")), "2026-08-02T05:50:00.000Z");
  assert.equal(nextLocalWorkerWakeAt(new Date("2026-08-02T05:50:00.000Z")), "2026-08-02T23:50:00.000Z");
});

test("detects missed slots for RunAtLoad and next-wake catch-up", () => {
  const now = new Date("2026-08-02T07:00:00.000Z");
  assert.equal(latestLocalWorkerSlotAt(now), "2026-08-02T06:00:00.000Z");
  assert.deepEqual(localWorkerCatchupRequired("2026-08-02T00:00:00.000Z", now), {
    latestSlot: "2026-08-02T06:00:00.000Z",
    required: true,
  });
  assert.deepEqual(localWorkerCatchupRequired("2026-08-02T06:00:00.000Z", now), {
    latestSlot: "2026-08-02T06:00:00.000Z",
    required: false,
  });
});

test("uses the prior day's 15:00 slot before the morning run", () => {
  assert.equal(latestLocalWorkerSlotAt(new Date("2026-08-02T23:00:00.000Z")), "2026-08-02T06:00:00.000Z");
});

import assert from "node:assert/strict";
import test from "node:test";

import { resourceHardDeleteBlocked } from "./admin-api.mjs";

test("generic admin API blocks hard deletion of client and rank history records", () => {
  assert.equal(resourceHardDeleteBlocked("clients"), true);
  assert.equal(resourceHardDeleteBlocked("naver-rank-trackers"), true);
  assert.equal(resourceHardDeleteBlocked("naver-rank-snapshots"), true);
});

test("ordinary mutable admin resources keep their existing delete behavior", () => {
  assert.equal(resourceHardDeleteBlocked("reports"), false);
  assert.equal(resourceHardDeleteBlocked("schedule-items"), false);
});

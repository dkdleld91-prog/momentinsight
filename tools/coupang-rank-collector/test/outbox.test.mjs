import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { OUTBOX_MAX_FILES, RECORD_FINAL_CODES } from "../lib/contract.mjs";
import { flushOutbox, listOutbox, saveOutbox } from "../lib/outbox.mjs";
import { nullLogger } from "../lib/log.mjs";
import { fakeClock, removeRoot, tempRoot } from "./helpers.mjs";

function runId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function apiReturning(responses) {
  const sent = [];
  return {
    sent,
    record: async (body) => {
      sent.push(body.runId);
      const next = responses.shift();
      return typeof next === "function" ? next(body) : next;
    },
  };
}

test("saveOutbox: outbox/<runId>.json 에 본문과 저장 시각, runId 형식이 틀리면 저장 안 함", () => {
  const root = tempRoot();
  try {
    const clock = fakeClock();
    assert.equal(saveOutbox(root, runId(1), { runId: runId(1), page: {} }, { now: clock.now, log: nullLogger() }), true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "outbox", `${runId(1)}.json`), "utf8"));
    assert.equal(saved.savedAt, new Date(clock.now()).toISOString());
    assert.equal(saved.body.runId, runId(1));
    assert.equal(saveOutbox(root, "../../etc/passwd", { x: 1 }), false);
    assert.equal(saveOutbox(root, "abc", { x: 1 }), false);
    assert.deepEqual(fs.readdirSync(path.join(root, "outbox")), [`${runId(1)}.json`]);
  } finally {
    removeRoot(root);
  }
});

test("saveOutbox: 20개를 넘으면 가장 오래된 것부터 지운다(outbox_dropped)", () => {
  const root = tempRoot();
  try {
    const clock = fakeClock();
    const log = nullLogger();
    for (let index = 1; index <= OUTBOX_MAX_FILES + 2; index += 1) {
      clock.advance(1000);
      saveOutbox(root, runId(index), { runId: runId(index) }, { now: clock.now, log });
    }
    const left = listOutbox(root).map((entry) => entry.runId);
    assert.equal(left.length, OUTBOX_MAX_FILES);
    assert.equal(left[0], runId(3));
    assert.equal(log.lines.filter((line) => / outbox_dropped .*reason=count/.test(line)).length, 2);
  } finally {
    removeRoot(root);
  }
});

test("flushOutbox: 200 은 삭제, RECORD_FINAL_CODES 만 버림, 그 밖 4xx 는 남기고 다음 파일로", async () => {
  const root = tempRoot();
  try {
    const clock = fakeClock();
    const log = nullLogger();
    const codes = [...RECORD_FINAL_CODES];
    let index = 0;
    for (; index < codes.length + 2; index += 1) {
      clock.advance(1000);
      saveOutbox(root, runId(index), { runId: runId(index) }, { now: clock.now });
    }
    const responses = [
      { status: 200, body: { ok: true, accepted: false, duplicate: true } },
      { status: 400, body: { ok: false, code: "SOMETHING_ELSE" } },
      ...codes.map((code) => ({ status: code === "JOB_TOO_OLD" ? 410 : 400, body: { ok: false, code } })),
    ];
    const api = apiReturning(responses);
    const result = await flushOutbox({ root, api, log, now: clock.now });
    assert.equal(result.stop, false);
    assert.equal(result.sent, 1);
    assert.equal(result.dropped, codes.length);
    assert.deepEqual(listOutbox(root).map((entry) => entry.runId), [runId(1)]);
    assert.equal(api.sent[0], runId(0), "오래된 순으로 보낸다");
    for (const code of codes) assert.ok(log.lines.some((line) => line.includes(` record_dropped `) && line.includes(`code=${code}`)), code);
  } finally {
    removeRoot(root);
  }
});

test("flushOutbox: 코드 없는 404(경로 덮임)는 남기고 실행 끝(api_route_missing), 401·426 도 남기고 끝", async () => {
  for (const [response, reason] of [
    [{ status: 404, body: null, routeMissing: true }, "route_missing"],
    [{ status: 404, body: { message: "Not found" }, routeMissing: true }, "route_missing"],
    [{ status: 401, body: { ok: false, code: "COLLECTOR_AUTH_REJECTED" } }, "auth_rejected"],
    [{ status: 426, body: { ok: false, code: "COLLECTOR_UPDATE_REQUIRED" } }, "update_required"],
  ]) {
    const root = tempRoot();
    try {
      const clock = fakeClock();
      const log = nullLogger();
      saveOutbox(root, runId(1), { runId: runId(1) }, { now: clock.now });
      clock.advance(1000);
      saveOutbox(root, runId(2), { runId: runId(2) }, { now: clock.now });
      const api = apiReturning([response, { status: 200, body: { ok: true } }]);
      const result = await flushOutbox({ root, api, log, now: clock.now });
      assert.equal(result.stop, true);
      assert.equal(result.reason, reason);
      assert.equal(api.sent.length, 1);
      assert.equal(listOutbox(root).length, 2);
      if (reason === "route_missing") assert.ok(log.lines.some((line) => / api_route_missing http=404 stage=outbox/.test(line)));
    } finally {
      removeRoot(root);
    }
  }
});

test("flushOutbox: 0·5xx 는 남기고 이번엔 그만 보낸다(실행은 계속), 25분 지난 파일은 지운다", async () => {
  const root = tempRoot();
  try {
    const clock = fakeClock();
    const log = nullLogger();
    saveOutbox(root, runId(1), { runId: runId(1) }, { now: clock.now });
    clock.advance(26 * 60000);
    saveOutbox(root, runId(2), { runId: runId(2) }, { now: clock.now });
    saveOutbox(root, runId(3), { runId: runId(3) }, { now: clock.now });
    const api = apiReturning([{ status: 0 }, { status: 200, body: { ok: true } }]);
    const result = await flushOutbox({ root, api, log, now: clock.now });
    assert.equal(result.stop, false);
    assert.equal(result.dropped, 1);
    assert.deepEqual(api.sent, [runId(2)]);
    assert.deepEqual(listOutbox(root).map((entry) => entry.runId), [runId(2), runId(3)]);
    assert.ok(log.lines.some((line) => / outbox_dropped run=00000000 reason=age/.test(line)));
    const api5 = apiReturning([{ status: 503, body: { ok: false, code: "COUPANG_SETUP_REQUIRED" } }]);
    assert.equal((await flushOutbox({ root, api: api5, log, now: clock.now })).stop, false);
    assert.equal(listOutbox(root).length, 2);
  } finally {
    removeRoot(root);
  }
});

test("listOutbox: 깨진 파일·이름이 틀린 파일은 지운다", () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, "outbox", `${runId(1)}.json`), "{bad");
    fs.writeFileSync(path.join(root, "outbox", "evil.json"), "{}");
    fs.writeFileSync(path.join(root, "outbox", "note.txt"), "keep");
    assert.deepEqual(listOutbox(root), []);
    assert.deepEqual(fs.readdirSync(path.join(root, "outbox")), ["note.txt"]);
  } finally {
    removeRoot(root);
  }
});

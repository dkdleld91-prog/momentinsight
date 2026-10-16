import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { splitItems } from "../lib/extract.mjs";
import { createLogger } from "../lib/log.mjs";
import { acquireLock } from "../lib/lock.mjs";
import { kstDay, parseTrialConfig, runTrial, summarizeTrial, trialPlan } from "../trial.mjs";
import { WINDOWS_CONFIG, fakeClock, fixture, removeRoot, tempRoot } from "./helpers.mjs";

const TRIAL_TEXT = JSON.stringify({
  keywords: ["아이폰 18프로 사생활 보호 필름"],
  casePair: ["iPhone 17 케이스", "iphone 17 케이스"],
  modes: ["normal", "offscreen", "minimized"],
  gapSeconds: [240, 360],
});

function page(overrides = {}) {
  const split = splitItems(fixture("page-full.json"));
  return {
    status: "ok", httpStatus: 200, loginWall: true, stable: true, noResultText: false, blockedText: false, itemCount: split.itemCount,
    organic: split.organic, ads: split.ads, finalHost: "www.coupang.com", finalPath: "/np/search", errorCode: null, ...overrides,
  };
}

test("trial.json 해석과 계획: 모드 3 × 키워드 1 + 대소문자 2 = 5회", () => {
  const trial = parseTrialConfig(`${String.fromCharCode(0xfeff)}${TRIAL_TEXT}`);
  const plan = trialPlan(trial);
  assert.equal(plan.length, 5);
  assert.deepEqual(plan.map((item) => `${item.kind}:${item.mode}`), ["mode:normal", "mode:offscreen", "mode:minimized", "case:offscreen", "case:offscreen"]);
  assert.throws(() => parseTrialConfig(JSON.stringify({ ...JSON.parse(TRIAL_TEXT), modes: ["fullscreen"] })), (error) => error.code === "trial_json_invalid");
  assert.throws(() => parseTrialConfig(JSON.stringify({ ...JSON.parse(TRIAL_TEXT), gapSeconds: [360, 240] })));
  assert.throws(() => parseTrialConfig(JSON.stringify({ ...JSON.parse(TRIAL_TEXT), casePair: ["a"] })));
  assert.throws(() => parseTrialConfig("nope"));
});

test("요약 줄 형식(§9.4)", () => {
  const plan = trialPlan(parseTrialConfig(TRIAL_TEXT));
  const ids = page().organic.map((item) => item.p);
  const results = plan.map((item) => ({ ...item, status: "ok", stable: true, organicCount: 50, itemCount: 60, durationMs: 13100, cleanupFailed: false, organicIds: ids }));
  const line = summarizeTrial({ plan, results, blocked: false, leftover: 0, priority: "BelowNormal", browser: "edge/141.0.3537.71" });
  assert.equal(line, "MI_COUPANG_TRIAL runs=5 ok=5 blocked=0 stableAll=yes item60=3/3 modes=normal:1/1,offscreen:1/1,minimized:1/1 caseSame=yes cleanupFail=0 leftover=0 priority=BelowNormal avgMs=13100 browser=edge/141.0.3537.71");
  const differ = results.map((item, index) => (index === 4 ? { ...item, organicIds: [...ids].reverse() } : item));
  assert.match(summarizeTrial({ plan, results: differ, blocked: false, leftover: 1, priority: "n/a", browser: "edge/x" }), / caseSame=no .*leftover=1 priority=n\/a /);
  const weak = results.map((item, index) => (index === 2 ? { ...item, stable: false, itemCount: 40 } : item));
  assert.match(summarizeTrial({ plan, results: weak, blocked: false, leftover: 0, priority: "n/a", browser: "edge/x" }), / stableAll=no item60=2\/3 modes=normal:1\/1,offscreen:1\/1,minimized:0\/1 /);
});

function trialHarness({ collects, random = () => 0.5 }) {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "trial.json"), TRIAL_TEXT);
  const clock = fakeClock();
  const output = [];
  const collected = [];
  const deps = {
    now: clock.now,
    sleep: clock.sleep,
    random,
    loadConfig: () => WINDOWS_CONFIG,
    acquireLock: (lockRoot, options) => acquireLock(lockRoot, options),
    createLogger: (logRoot, options) => createLogger(logRoot, options),
    collectKeyword: async (args) => {
      collected.push(args);
      if (args.onLaunched) await args.onLaunched({ pid: 999 });
      clock.advance(13000);
      const next = collects.shift() || {};
      return { page: page(next.page), durationMs: 13000, browser: "edge 141.0.3537.71", browserVersion: "141.0.3537.71", cleanupFailed: Boolean(next.cleanupFailed) };
    },
    runGuard: () => ({ ok: true, mode: "none" }),
    killOrphanBrowser: () => ({ killed: false }),
    sweepStaleProfiles: () => 0,
    countProfileDirs: () => 0,
    readWindowsPriority: (pid) => (pid === 999 ? "BelowNormal" : "unknown"),
    checkNodeRuntime: () => true,
  };
  return { root, clock, output, collected, run: () => runTrial({ appDir: path.join(root, "app"), stdout: (line) => output.push(line), deps }), cleanup: () => removeRoot(root) };
}

test("runTrial: 5회, 회 사이 240~360초, 결과 jsonl(키워드 포함)·summary.txt·표준 출력, 서버 호출 없음", async () => {
  const h = trialHarness({ collects: [] });
  try {
    const result = await h.run();
    assert.equal(h.collected.length, 5);
    assert.deepEqual(h.collected.map((args) => args.windowMode), ["normal", "offscreen", "minimized", "offscreen", "offscreen"]);
    assert.equal(h.collected[3].keyword, "iPhone 17 케이스");
    assert.equal(h.clock.sleeps.length, 4);
    assert.ok(h.clock.sleeps.every((ms) => ms >= 240000 && ms <= 360000));
    assert.equal(h.output.length, 1);
    assert.equal(h.output[0], result.line);
    assert.match(h.output[0], /^MI_COUPANG_TRIAL runs=5 ok=5 blocked=0 stableAll=yes item60=3\/3 .* caseSame=yes cleanupFail=0 leftover=0 priority=BelowNormal avgMs=13000 browser=edge\/141\.0\.3537\.71$/);
    const summary = fs.readFileSync(path.join(h.root, "trial-results", "summary.txt"), "utf8").trim();
    assert.equal(summary, h.output[0]);
    const lines = fs.readFileSync(path.join(h.root, "trial-results", `${kstDay(h.clock.now())}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 6);
    assert.equal(lines[0].keyword, "아이폰 18프로 사생활 보호 필름");
    assert.equal(lines[5].summary, h.output[0]);
    assert.equal(fs.existsSync(path.join(h.root, "state", "worker.lock")), false);
  } finally {
    h.cleanup();
  }
});

test("runTrial: 403·차단 문구가 한 번이라도 나오면 그 자리에서 멈추고 blocked=1", async () => {
  const h = trialHarness({ collects: [{}, { page: { status: "error", httpStatus: 403, organic: [], ads: [], errorCode: "cdp_error" } }] });
  try {
    await h.run();
    assert.equal(h.collected.length, 2);
    assert.match(h.output[0], /^MI_COUPANG_TRIAL runs=2 ok=1 blocked=1 stableAll=no /);
  } finally {
    h.cleanup();
  }
});

test("runTrial: trial.json 이 없거나 잠겨 있으면 MI_COUPANG_TRIAL_FAIL", async () => {
  const h = trialHarness({ collects: [] });
  try {
    fs.rmSync(path.join(h.root, "trial.json"));
    await h.run();
    assert.deepEqual(h.output, ["MI_COUPANG_TRIAL_FAIL code=trial_json_invalid"]);
  } finally {
    h.cleanup();
  }
  const locked = trialHarness({ collects: [] });
  try {
    const held = acquireLock(locked.root, { now: locked.clock.now });
    held.refresh();
    await locked.run();
    assert.deepEqual(locked.output, ["MI_COUPANG_TRIAL_FAIL code=locked"]);
    assert.equal(locked.collected.length, 0);
    held.release();
  } finally {
    locked.cleanup();
  }
});

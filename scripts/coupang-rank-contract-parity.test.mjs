// C 30일 순위: 서버 계약(src/server/coupang-rank/contract.mjs)과 수집기 사본(tools/coupang-rank-collector/lib/contract.mjs)이
// 같은 이름의 값을 같게 가지는지 확인한다(명세 §6.8·§9.2). 수집기는 폴더 밖을 import 하지 않으므로 값을 복사해 두는데,
// 한쪽만 바뀌면 서버와 수집기가 서로 다른 상한·코드로 움직인다. 이 테스트가 그 어긋남을 막는다.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as server from "../src/server/coupang-rank/contract.mjs";
import * as collector from "../tools/coupang-rank-collector/lib/contract.mjs";

const COLLECTOR_CONTRACT_SOURCE = fs.readFileSync(
  new URL("../tools/coupang-rank-collector/lib/contract.mjs", import.meta.url),
  "utf8",
);
const SERVER_CONTRACT_SOURCE = fs.readFileSync(
  new URL("../src/server/coupang-rank/contract.mjs", import.meta.url),
  "utf8",
);

// §9.2 가 "서버와 같은 이름·값"으로 못 박은 이름 + §6.8 이 비교하라고 한 RANK_TOP.
const REQUIRED_SHARED_NAMES = [
  "COLLECTOR_VERSION_HEADER",
  "COLLECTOR_TOKEN_PATTERN",
  "PUBLIC_ORIGIN",
  "COUPANG_WORKER_PATH",
  "WORKER_BODY_MAX_BYTES",
  "RUN_BUDGET_SECONDS",
  "CLAIM_MIN_REMAINING_SECONDS",
  "MIN_BROWSER_GAP_SECONDS",
  "BROWSER_HARD_CAP_SECONDS",
  "NAV_TIMEOUT_MS",
  "LEASE_SECONDS",
  "OUTBOX_MAX_AGE_MINUTES",
  "ORGANIC_MAX",
  "ADS_MAX",
  "TITLE_MAX",
  "SLOT_MAX",
  "PAGE_STATUSES",
  "WINDOW_MODES",
  "RELEASE_REASONS",
  "BLOCKED_HTTP_STATUSES",
  "RECORD_FINAL_CODES",
  "RANK_TOP",
];

// §3(공유 계약) 표의 값. 두 사본이 함께 틀어져도(같이 바뀌어도) 잡히도록 명세 값과도 맞춘다.
const SPEC_VALUES = {
  COLLECTOR_VERSION_HEADER: "x-mi-coupang-collector",
  PUBLIC_ORIGIN: "https://insight.momentlabs.co.kr",
  COUPANG_WORKER_PATH: "/api/coupang-rank-worker",
  WORKER_BODY_MAX_BYTES: 65536,
  RUN_BUDGET_SECONDS: 480,
  CLAIM_MIN_REMAINING_SECONDS: 90,
  MIN_BROWSER_GAP_SECONDS: 30,
  BROWSER_HARD_CAP_SECONDS: 120,
  NAV_TIMEOUT_MS: 45000,
  LEASE_SECONDS: 180,
  OUTBOX_MAX_AGE_MINUTES: 25,
  ORGANIC_MAX: 100,
  ADS_MAX: 30,
  TITLE_MAX: 80,
  SLOT_MAX: 200,
  RANK_TOP: 50,
  PAGE_STATUSES: ["ok", "blocked", "timeout", "error"],
  WINDOW_MODES: ["normal", "offscreen", "minimized"],
  RELEASE_REASONS: ["guard", "shutdown", "budget"],
  BLOCKED_HTTP_STATUSES: [403, 429, 503],
  RECORD_FINAL_CODES: ["JOB_NOT_FOUND", "JOB_LEASE_MISMATCH", "JOB_KEYWORD_MISMATCH", "JOB_TOO_OLD", "PAGE_INVALID", "RUN_STATUS_INVALID", "BODY_INVALID"],
  DEFAULT_WINDOW_MODE: "offscreen",
};

function exportedValues(module) {
  return Object.fromEntries(Object.entries(module));
}

function assertSameValue(name, left, right) {
  if (left instanceof RegExp || right instanceof RegExp) {
    assert.ok(left instanceof RegExp && right instanceof RegExp, `${name}: 한쪽만 정규식`);
    assert.equal(left.source, right.source, `${name}: 정규식 source`);
    assert.equal(left.flags, right.flags, `${name}: 정규식 flags`);
    return;
  }
  if (typeof left === "function" || typeof right === "function") {
    assert.equal(typeof left, typeof right, `${name}: 한쪽만 함수`);
    assert.equal(String(left), String(right), `${name}: 함수 원문`);
    return;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    assert.ok(Array.isArray(left) && Array.isArray(right), `${name}: 한쪽만 배열`);
    assert.equal(Object.isFrozen(left), Object.isFrozen(right), `${name}: freeze 여부`);
  }
  assert.deepStrictEqual(left, right, name);
}

test("§9.2 공용 이름이 양쪽 모두에 있다", () => {
  for (const name of REQUIRED_SHARED_NAMES) {
    assert.ok(Object.hasOwn(server, name), `서버 계약에 ${name} 없음`);
    assert.ok(Object.hasOwn(collector, name), `수집기 계약에 ${name} 없음`);
  }
});

test("같은 이름으로 내보낸 값은 모두 같다(상한·시간·열거값·정규식 source·도메인·경로·코드 목록)", () => {
  const serverValues = exportedValues(server);
  const collectorValues = exportedValues(collector);
  const shared = Object.keys(collectorValues).filter((name) => Object.hasOwn(serverValues, name));
  assert.ok(shared.length >= REQUIRED_SHARED_NAMES.length, `shared=${shared.length}`);
  for (const name of shared) assertSameValue(name, serverValues[name], collectorValues[name]);
});

test("수집기 묶음 버전 = 서버가 기대하는 묶음 버전, 둘 다 x.y.z", () => {
  assert.equal(collector.COLLECTOR_VERSION, server.COLLECTOR_BUNDLE_VERSION);
  assert.match(collector.COLLECTOR_VERSION, server.VERSION_PATTERN);
  assert.equal(server.compareVersion(collector.COLLECTOR_VERSION, server.COLLECTOR_BUNDLE_VERSION), 0);
});

test("공용 값이 명세 §3 표의 값과 같다", () => {
  for (const [name, expected] of Object.entries(SPEC_VALUES)) {
    assert.deepStrictEqual(server[name], expected, `서버 ${name}`);
    if (Object.hasOwn(collector, name)) assert.deepStrictEqual(collector[name], expected, `수집기 ${name}`);
  }
  assert.equal(server.COLLECTOR_TOKEN_PATTERN.source, "^mic1_[A-Za-z0-9_-]{43}$");
  assert.equal(server.COLLECTOR_TOKEN_PATTERN.flags, "");
  assert.equal(server.COLLECTOR_ERROR_CODE_PATTERN.source, "^[a-z0-9_]{1,60}$");
  assert.ok(server.WINDOW_MODES.includes(server.DEFAULT_WINDOW_MODE));
});

test("보관함이 버리는 코드는 서버가 실제로 4xx 로 내는 코드다", () => {
  for (const code of collector.RECORD_FINAL_CODES) {
    const status = server.ERROR_HTTP_STATUS[code];
    assert.ok(Number.isInteger(status) && status >= 400 && status < 500, `${code} → ${status}`);
  }
  // 401·426 은 버리지 않고 실행을 끝낸다(§9.2 보관함 표). 그래서 목록에 없어야 한다
  for (const code of ["COLLECTOR_AUTH_REJECTED", "COLLECTOR_UPDATE_REQUIRED", "COUPANG_SETUP_REQUIRED", "COUPANG_RANK_WORKER_FAILED", "BODY_TOO_LARGE"]) {
    assert.equal(collector.RECORD_FINAL_CODES.includes(code), false, code);
  }
});

test("차단 HTTP 상태·쪽 상태·창 방식·반납 사유가 서버 열거값과 맞물린다", () => {
  assert.deepStrictEqual([...collector.BLOCKED_HTTP_STATUSES].sort((a, b) => a - b), [403, 429, 503]);
  assert.ok(collector.PAGE_STATUSES.includes("blocked"));
  for (const status of collector.PAGE_STATUSES) {
    assert.ok(server.RUN_STATUSES.includes(status), `쪽 상태 ${status} 는 회차 상태이기도 하다`);
  }
  assert.ok(collector.WINDOW_MODES.includes(collector.DEFAULT_WINDOW_MODE));
});

test("수집기 오류 코드는 같은 목록이고 모두 §3.5 형식이다", () => {
  assert.deepStrictEqual(collector.COLLECTOR_ERROR_CODES, server.COLLECTOR_ERROR_CODES);
  for (const code of collector.COLLECTOR_ERROR_CODES) {
    assert.match(code, collector.COLLECTOR_ERROR_CODE_PATTERN);
  }
  assert.ok(collector.COLLECTOR_ERROR_CODES.includes(server.FOREIGN_NAVIGATION_ERROR_CODE));
  assert.equal(new Set(collector.COLLECTOR_ERROR_CODES).size, collector.COLLECTOR_ERROR_CODES.length);
});

test("시간 값끼리 앞뒤가 맞는다(임대 안에 브라우저가 끝나고, 보관함은 보고 기한보다 먼저 버린다)", () => {
  // claim 뒤 최소 간격을 기다리고 브라우저를 최대치로 써도 임대(180초) 안에 끝난다
  assert.ok(collector.MIN_BROWSER_GAP_SECONDS + collector.BROWSER_HARD_CAP_SECONDS < collector.LEASE_SECONDS);
  assert.ok(collector.NAV_TIMEOUT_MS / 1000 < collector.BROWSER_HARD_CAP_SECONDS);
  // 서버가 늦은 결과를 30분까지 받으므로, 수집기 보관함은 그보다 먼저(25분) 버린다
  assert.ok(collector.OUTBOX_MAX_AGE_MINUTES < server.RECORD_MAX_AGE_MINUTES);
  // 남은 예산이 90초 미만이면 claim 하지 않으므로 실행 예산은 그보다 커야 한다
  assert.ok(collector.RUN_BUDGET_SECONDS > collector.CLAIM_MIN_REMAINING_SECONDS);
  // 쪽 위치 s 의 상한은 일반+광고 상한 합보다 작지 않다
  assert.ok(collector.SLOT_MAX >= collector.ORGANIC_MAX + collector.ADS_MAX);
  assert.ok(collector.RANK_TOP <= collector.ORGANIC_MAX);
});

test("수집기 계약은 아무것도 import 하지 않고, 서버 계약은 다른 서버 모듈을 import 하지 않는다", () => {
  assert.equal(/^\s*import\s/m.test(COLLECTOR_CONTRACT_SOURCE), false);
  assert.equal(/\bimport\s*\(/.test(COLLECTOR_CONTRACT_SOURCE), false);
  assert.equal(/^\s*import\s/m.test(SERVER_CONTRACT_SOURCE), false);
  assert.equal(/\bimport\s*\(/.test(SERVER_CONTRACT_SOURCE), false);
});

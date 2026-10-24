// 서버와 같은 약속인지(지난 결함: 확장이 본 차단이 서버 판정·중지로 이어지지 않음, 확장 ID·zip 경로 어긋남).
// 서버 파일은 읽기만 한다. '지금 확인' 서버 쪽(MANUAL_* 상수·validateManualRecord·classifyManualPage)은 서버 담당이 넣는다.
// 그 부분이 아직 없으면 아래 '서버 수동 계약' 테스트가 실패한다(통합 때 반드시 맞춰야 하는 값이라 건너뛰지 않는다).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as contract from "../../../src/server/coupang-rank/contract.mjs";
import * as pageResult from "../../../src/server/coupang-rank/page-result.mjs";
import { handleCoupangRankTrackersRequest } from "../../../src/server/handlers/coupang-rank-trackers.mjs";
import { manualChangedParams, manualDiagnostics } from "../../../src/server/coupang-rank/manual.mjs";
import { PRIMARY_AGENCY_CODE } from "../../../src/server/owner-identity.mjs";
import { ZIP_FOLDER, extensionIdFromKey, publishedZipPath } from "../../../scripts/build-coupang-check-extension.mjs";
import { assemblePage, buildDiagnostics, diagnosticText, diagnosticsBytes, diagnosticsNodes, isStopSignal, stopReasonOf } from "../lib/assemble.js";
import {
  BLOCKED_HTTP_STATUSES, CHANGED_PARAMS_MAX, CHANGED_PARAM_NAME_MAX, CLAIM_ID_PARAM, CLAIM_TOKEN_HEADER, CLAIM_TOKEN_PATTERN, DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_NODES_MAX, DIAGNOSTICS_SCHEMA, DIAGNOSTICS_TOP_KEYS, DIAG_TEXT_MAX, EXTENSION_VERSION, NOT_STARTED_CODES,
  PAGE_ERROR_CODES, SERVER_ORIGIN, STOP_REASONS, STOP_REASON_PARAM, STOP_VIEW, TRACKERS_PATH, UNREADABLE_ERROR_CODE,
  VERIFY_VIEW, reportStop, verifyClaim,
} from "../lib/protocol.js";
import { CLAIM_ID, CLAIM_TOKEN, SERVER_KEYWORD, fixture, readExtension } from "./helpers.mjs";

const manifest = JSON.parse(readExtension("manifest.json"));
const full = fixture("page-full.json");
const SEARCH = { host: "www.coupang.com", path: "/np/search" };

// 확장이 만들 수 있는 page 사례 → 서버 기존 규칙(classifyCollectorPage)의 기대 판정
const CASES = [
  ["정상 60개", assemblePage({ ...full, ...SEARCH, httpStatus: 200, stable: true, query: "아이폰 케이스" }), "ok"],
  ["흔들림", assemblePage({ ...full, ...SEARCH, httpStatus: 200, stable: false, query: "q" }), "partial"],
  ["결과 없음 문구", assemblePage({ ...fixture("page-no-result.json"), httpStatus: 200, stable: true, query: "q" }), "noresult"],
  ["광고만·일반 0", assemblePage({ ...SEARCH, httpStatus: 200, stable: true, items: full.items.filter((item) => item.ad), query: "q" }), "empty"],
  ["403", assemblePage({ ...SEARCH, httpStatus: 403, items: [], blockedText: true }), "blocked"],
  ["429", assemblePage({ ...SEARCH, httpStatus: 429, items: [] }), "blocked"],
  ["200+한국어 차단 문구", assemblePage({ ...SEARCH, httpStatus: 200, items: [], blockedText: true }), "blocked"],
  ["시간 초과+403", assemblePage({ ...SEARCH, httpStatus: 403, items: [] }, { errorCode: "page_timeout" }), "blocked"],
  ["시간 초과", assemblePage({ ...SEARCH, httpStatus: null, items: [] }, { errorCode: "page_timeout" }), "timeout"],
  ["사람이 닫음", assemblePage({}, { errorCode: "window_closed" }), "error"],
  ["120초", assemblePage({ ...SEARCH }, { errorCode: "browser_hard_cap" }), "error"],
  ["오류 쪽", assemblePage({ ...SEARCH }, { errorCode: "page_load_failed" }), "error"],
  ["상품 누름", assemblePage({ host: "www.coupang.com", path: "/vp/products/123" }, { errorCode: "user_navigated" }), "error"],
  ["측정 중 쿼리만 바뀜(바뀐 이름)", assemblePage({ ...full, ...SEARCH, httpStatus: 200, navigated: true, changedParams: ["channel", "traceId"], query: "q" }), "error"],
  ["읽을 수 없는 곳(D1)", assemblePage({}, { errorCode: UNREADABLE_ERROR_CODE }), "error"],
  // 2026-10-23 검토 반영: 읽기를 끝내지 못한 회차도 본 신호를 싣는다
  ["시간 초과 중 권한 밖으로 보내짐(D1)", assemblePage({ httpStatus: null, blockedText: false, host: "", path: "" }, { errorCode: UNREADABLE_ERROR_CODE }), "error"],
  ["첫 읽기 전에 닫힘 + 불러오며 본 403", assemblePage({ ...SEARCH, httpStatus: 403, blockedText: false }, { errorCode: "window_closed" }), "blocked"],
  ["첫 읽기 전에 닫힘 + 불러오며 본 차단 문구", assemblePage({ ...SEARCH, httpStatus: 200, blockedText: true }, { errorCode: "window_closed" }), "blocked"],
  ["120초 상한 + 본 429", assemblePage({ ...SEARCH, httpStatus: 429 }, { errorCode: "browser_hard_cap" }), "blocked"],
  ["쿠팡 다른 쪽", assemblePage({ host: "www.coupang.com", path: "/np/campaigns/1", httpStatus: 200, stable: false, items: full.items }), "unsupported"],
];

function shapedBody(page) {
  return { runId: CLAIM_ID, keywordKey: "x", page, durationMs: 14231, collectorVersion: EXTENSION_VERSION, browser: "chrome 141" };
}

test("기존 서버 규칙: 확장 page 는 수집기 page 검증을 통과하고, 판정이 기대와 같다", () => {
  for (const [name, page, expected] of CASES) {
    const checked = pageResult.validateCollectorRecord(shapedBody(page));
    assert.deepEqual(checked, { ok: true }, name);
    assert.equal(pageResult.classifyCollectorPage(page).status, expected, name);
  }
});

test("확장 '그날 중지' 신호 ⇔ 서버 차단 판정(page_unreadable 은 서버 수동 규칙 M1)", () => {
  for (const [name, page, expected] of CASES) {
    const serverBlocked = expected === "blocked" || page.errorCode === UNREADABLE_ERROR_CODE;
    assert.equal(isStopSignal(page), serverBlocked, name);
  }
});

test("공통 값: 서버 주소·경로·차단 HTTP·오류 코드 모양", () => {
  assert.equal(contract.PUBLIC_ORIGIN, SERVER_ORIGIN);
  assert.equal(contract.COUPANG_TRACKERS_PATH, TRACKERS_PATH);
  assert.deepEqual([...contract.BLOCKED_HTTP_STATUSES], [...BLOCKED_HTTP_STATUSES]);
  for (const code of PAGE_ERROR_CODES) assert.match(code, contract.COLLECTOR_ERROR_CODE_PATTERN);
});

test("서버 수동 계약: 확장 ID·버전·zip 경로·토큰 모양·코드 목록이 서버 contract 와 같다", () => {
  assert.equal(contract.MANUAL_EXTENSION_ID, extensionIdFromKey(manifest.key), "contract MANUAL_EXTENSION_ID = manifest key 로 계산한 ID");
  assert.equal(contract.MANUAL_EXTENSION_VERSION, manifest.version);
  assert.equal(contract.MANUAL_EXTENSION_ZIP_PATH, publishedZipPath(manifest.version));
  assert.equal(String(contract.MANUAL_TOKEN_PATTERN), String(CLAIM_TOKEN_PATTERN));
  const serverNotStarted = new Set(contract.MANUAL_NOT_STARTED_CODES || []);
  assert.deepEqual(NOT_STARTED_CODES.filter((code) => !serverNotStarted.has(code)), [], "서버 MANUAL_NOT_STARTED_CODES 에 없는 확장 코드");
  const serverPageCodes = new Set(contract.MANUAL_EXTENSION_ERROR_CODES || []);
  assert.deepEqual(PAGE_ERROR_CODES.filter((code) => !serverPageCodes.has(code)), [], "서버 MANUAL_EXTENSION_ERROR_CODES 에 없는 확장 쪽 오류 코드");
});

test("서버 수동 판정: 확장 page 는 validateManualRecord 를 통과하고, page_unreadable 은 차단(D1)·광고만은 차단 아님", () => {
  assert.equal(typeof pageResult.validateManualRecord, "function", "page-result.mjs validateManualRecord");
  assert.equal(typeof pageResult.classifyManualPage, "function", "page-result.mjs classifyManualPage");
  for (const [name, page] of CASES) {
    const body = { claimId: CLAIM_ID, page, durationMs: 14231, extensionVersion: EXTENSION_VERSION, browser: "chrome 141" };
    assert.deepEqual(pageResult.validateManualRecord(body), { ok: true }, name);
    const status = pageResult.classifyManualPage(page).status;
    assert.equal(status === "blocked", isStopSignal(page), `${name}: 서버 ${status}`);
  }
  assert.equal(pageResult.classifyManualPage(assemblePage({}, { errorCode: UNREADABLE_ERROR_CODE })).status, "blocked");
  const adsOnly = CASES.find(([name]) => name === "광고만·일반 0")[1];
  assert.notEqual(pageResult.classifyManualPage(adsOnly).status, "blocked");
});

test("서버 수동 계약: 바뀐 쿼리 이름(page.changedParams) 상한이 같고, 확장이 만든 이름 목록은 서버가 그대로 받는다", () => {
  assert.equal(contract.MANUAL_CHANGED_PARAMS_MAX, CHANGED_PARAMS_MAX);
  assert.equal(contract.MANUAL_CHANGED_PARAM_NAME_MAX, CHANGED_PARAM_NAME_MAX);
  const names = Array.from({ length: 12 }, (_, index) => `n${index}\u0001${"가".repeat(45)}`);
  const page = assemblePage({ ...SEARCH, navigated: true, changedParams: ["q", " ", ...names] });
  assert.equal(page.errorCode, "user_navigated");
  assert.equal(page.changedParams.length, CHANGED_PARAMS_MAX);
  assert.deepEqual(manualChangedParams(page), page.changedParams, "확장이 다듬은 목록 = 서버가 받는 목록");
  assert.deepEqual(pageResult.validateManualRecord({ claimId: CLAIM_ID, page, durationMs: 14231, extensionVersion: EXTENSION_VERSION, browser: "chrome 141" }), { ok: true });
});

// 1.0.1 검토 반영: 진단 상수가 주석으로만 이어져 있었다 — 한쪽만 바뀌면 진단이 조용히 버려지므로 값·칸 목록을 직접 대조한다.
test("서버 수동 계약: 진단 상수(스키마·4KB·글자 200자·값 개수·맨 위 칸 목록)가 서버와 같고, 확장이 만드는 가장 큰 진단·다듬은 글자를 서버가 그대로 받는다", () => {
  assert.equal(contract.MANUAL_DIAGNOSTICS_SCHEMA, DIAGNOSTICS_SCHEMA);
  assert.equal(contract.MANUAL_DIAGNOSTICS_MAX_BYTES, DIAGNOSTICS_MAX_BYTES);
  assert.equal(contract.MANUAL_DIAGNOSTICS_TEXT_MAX, DIAG_TEXT_MAX);
  assert.equal(contract.MANUAL_DIAGNOSTICS_NODES_MAX, DIAGNOSTICS_NODES_MAX);
  assert.deepEqual([...contract.MANUAL_DIAGNOSTICS_TOP_KEYS], [...DIAGNOSTICS_TOP_KEYS]);
  const names = ["verified", "nav", "load", "quick", "measureStart", "measureEnd", "retryStart", "retryLoad", "retryQuick", "retryMeasureStart", "retryMeasureEnd", "timeoutQuick", "capQuick", "end"];
  const ms = Object.fromEntries(names.map((name, index) => [name, 599990 + index]));
  const load = { how: "complete", loading: 999999, complete: 999999, urls: 999999, completeAt: [599999, 599998, 599997, 599996, 599995, 599994, 1] };
  const retry = { tried: true, skip: "address_changed", load: "complete", result: "address_changed" };
  const kept = new Set();
  for (const text of ["가".repeat(300), "😀".repeat(300), "\"\\".repeat(300), "a", ""]) {
    const doc = { nav: "back_forward", ready: "interactive", title: text, bodyLen: 999999, bodyHead: text, units: 999999, links: 999999, blocked: true, hidden: true };
    const diag = buildDiagnostics({
      version: EXTENSION_VERSION, page: { status: "error", errorCode: "extract_failed", wasHidden: true }, ms, load,
      tries: Array.from({ length: 6 }, () => ({ kind: "extract_error", msg: text })), doc, firstDoc: { ...doc, nav: "navigate" }, retry,
      hidden: true, unexpected: text || "x", seen: { httpStatus: 429, blockedText: true },
    });
    for (const key of Object.keys(diag)) {
      assert.ok(DIAGNOSTICS_TOP_KEYS.includes(key), `확장이 만든 맨 위 칸 ${key} 가 서버 목록에 없다`);
      kept.add(key);
    }
    assert.ok(diagnosticsBytes(diag) <= DIAGNOSTICS_MAX_BYTES);
    assert.ok(diagnosticsNodes(diag) <= DIAGNOSTICS_NODES_MAX, String(diagnosticsNodes(diag)));
    assert.deepEqual(manualDiagnostics({ page: { diagnostics: diag } }), JSON.parse(JSON.stringify(diag)), `서버 통과(${text.slice(0, 2)})`);
  }
  assert.deepEqual([...kept].sort(), [...DIAGNOSTICS_TOP_KEYS].sort(), "확장이 실제로 쓰는 맨 위 칸 = 서버 목록(남는 이름 없음)");
  // 서버가 진단에서 버리는 글자 범주(제어 Cc·서식 Cf·줄/문단 구분) 전부: 확장이 다듬은 글은 서버를 통과한다.
  const forbidden = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
  let checked = 0;
  for (let point = 0; point <= 0x10ffff; point += 1) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const char = String.fromCodePoint(point);
    if (!forbidden.test(char)) continue;
    checked += 1;
    const text = diagnosticText(`a${char}b https://x.y/z?q=${char}`);
    assert.equal(forbidden.test(text), false, point.toString(16));
    assert.notEqual(manualDiagnostics({ diagnostics: { v: 1, ext: EXTENSION_VERSION, unexpected: text } }), null, point.toString(16));
    assert.equal(manualDiagnostics({ diagnostics: { v: 1, ext: EXTENSION_VERSION, unexpected: `a${char}b` } }), null, `서버는 다듬지 않은 ${point.toString(16)} 를 버린다`);
  }
  assert.ok(checked > 200, String(checked));
});

test("서버 수동 계약: 요청 이름(view·claimId·reason·토큰 머리글)·중지 사유·zip 폴더가 서버 contract 와 같다", () => {
  assert.equal(contract.MANUAL_VERIFY_VIEW, VERIFY_VIEW);
  assert.equal(contract.MANUAL_STOP_VIEW, STOP_VIEW);
  assert.equal(contract.MANUAL_CLAIM_ID_PARAM, CLAIM_ID_PARAM);
  assert.equal(contract.MANUAL_STOP_REASON_PARAM, STOP_REASON_PARAM);
  assert.equal(contract.MANUAL_CLAIM_TOKEN_HEADER, CLAIM_TOKEN_HEADER);
  assert.deepEqual([...contract.MANUAL_STOP_CODES], [...STOP_REASONS]);
  for (const code of ["blocked_today", "report_pending"]) {
    assert.ok(contract.MANUAL_STOP_NOT_STARTED_CODES.includes(code), `확장 ${code}(오늘 차단을 봄) 보고 = 서버 그날 중지`);
  }
  assert.equal(contract.MANUAL_EXTENSION_FOLDER, ZIP_FOLDER);
});

test("중지 사유: 확장 stopReasonOf = 서버 manualStopSignal(모든 page 사례)", () => {
  assert.equal(typeof pageResult.manualStopSignal, "function");
  for (const [name, page] of CASES) assert.equal(stopReasonOf(page), pageResult.manualStopSignal(page), name);
});

// 확장이 만든 GET 요청을 실제 핸들러에 그대로 넣는다(게이트가 심는 총관리자 세션 머리글만 더한다).
function handlerFetch(rpcCalls, rpcData) {
  const settings = { id: 1, manual_enabled: true, team_access_enabled: false, client_access_enabled: false };
  const ctx = {
    supabaseAdmin: {
      from() {
        const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: settings, error: null }) };
        return query;
      },
      async rpc(name, args) {
        rpcCalls.push({ name, args });
        return { data: rpcData(name, args), error: null };
      },
    },
  };
  return async (url, init) => {
    const headers = new Headers(init.headers);
    headers.set("x-mi-session-role", "owner");
    headers.set("x-mi-session-scope", "account-only");
    headers.set("x-mi-owner-agency-code", PRIMARY_AGENCY_CODE);
    const response = await handleCoupangRankTrackersRequest(new Request(url, { method: init.method, headers }), ctx);
    return { status: response.status, text: () => response.text() };
  };
}

test("확장의 GET manual-verify·manual-stop 요청이 실제 핸들러를 통과한다(토큰은 sha256 으로만 RPC 에 간다)", async () => {
  const rpcCalls = [];
  const serverTime = "2026-10-23T03:00:00.000Z";
  const fetchImpl = handlerFetch(rpcCalls, (name, args) => {
    if (name === "coupang_rank_manual_verify") {
      return { ok: true, verified: true, claimId: args.p_claim_id, keyword: SERVER_KEYWORD, keywordKey: SERVER_KEYWORD, verifiedAt: serverTime, serverTime };
    }
    if (name === "coupang_rank_manual_stop") return { ok: true, stopped: true, stoppedDay: "2026-10-23", stopCode: args.p_code, manual: { state: "stopped" } };
    return { ok: false, code: "COUPANG_ACTION_INVALID" };
  });
  const verified = await verifyClaim(fetchImpl, { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.keyword, SERVER_KEYWORD);
  assert.equal(verified.serverTimeMs, Date.parse(serverTime));
  const stopped = await reportStop(fetchImpl, { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN, reason: "blocked_http_403" });
  assert.deepEqual(stopped, { ok: true, stopped: true, httpStatus: 200 });
  const sha = createHash("sha256").update(CLAIM_TOKEN, "utf8").digest("hex");
  assert.deepEqual(rpcCalls.map((call) => call.name), ["coupang_rank_manual_verify", "coupang_rank_manual_stop"]);
  for (const call of rpcCalls) {
    assert.equal(call.args.p_claim_id, CLAIM_ID);
    assert.equal(call.args.p_token_sha256, sha);
    assert.ok(!JSON.stringify(call.args).includes(CLAIM_TOKEN), "토큰 원문은 RPC 에 가지 않는다");
  }
  assert.equal(rpcCalls[1].args.p_code, "blocked_http_403");

  // 서버가 간격으로 거절하면 확장은 verify_refused + 서버 코드(창을 열지 않음).
  const refusing = handlerFetch([], () => ({ ok: false, state: "gap", manual: { state: "gap", nextAt: "2026-10-23T03:02:00.000Z", serverTime } }));
  const refused = await verifyClaim(refusing, { claimId: CLAIM_ID, claimToken: CLAIM_TOKEN });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "verify_refused");
  assert.equal(refused.serverCode, "COUPANG_MANUAL_GAP");
  assert.equal(refused.retryAfterSec, 120);
});

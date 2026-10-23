// C 30일 순위 ① 지금 확인 서버 도우미(manual.mjs) 검사(spec-manual §10.3).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ERROR_HTTP_STATUS,
  MANUAL_CLAIM_TTL_SECONDS,
  MANUAL_EXTENSION_FOLDER,
  MANUAL_EXTENSION_ID,
  MANUAL_EXTENSION_VERSION,
  MANUAL_EXTENSION_ZIP_PATH,
  MANUAL_MIN_EXTENSION_VERSION,
  MANUAL_STATES,
  MANUAL_STOP_CODES,
  MANUAL_TOKEN_PATTERN,
  VERSION_PATTERN,
} from "./contract.mjs";
import {
  MANUAL_MESSAGES,
  MANUAL_STATE_CODES,
  finalManualStatus,
  generateManualClaimToken,
  hasManualColumns,
  isManualToken,
  manualChangedParams,
  manualNavigatedFinalPath,
  manualPayload,
  manualRecordStopCode,
  manualRefusal,
  manualStateCode,
  manualTokenHash,
} from "./manual.mjs";

const SOURCE = readFileSync(new URL("./manual.mjs", import.meta.url), "utf8");

const SUMMARY = Object.freeze({
  state: "gap",
  enabled: true,
  usedToday: 3,
  maxPerDay: 30,
  minGapSeconds: 180,
  fromHour: 9,
  toHour: 19,
  nextAt: "2026-10-23T03:03:00+00:00",
  busyUntil: null,
  lastSearchAt: "2026-10-23T03:00:00+00:00",
  stoppedDay: null,
  stoppedAt: null,
  stoppedCode: null,
  cooldownUntil: null,
  serverTime: "2026-10-23T03:01:10.400+00:00",
});

test("요청 토큰: mcm1_ + base64url 43자, 해시는 소문자 64자 sha256, 매번 다르다", () => {
  const first = generateManualClaimToken();
  const second = generateManualClaimToken();
  assert.match(first.token, MANUAL_TOKEN_PATTERN);
  assert.match(first.tokenSha256, /^[0-9a-f]{64}$/);
  assert.equal(first.tokenSha256, manualTokenHash(first.token));
  assert.notEqual(first.token, second.token);
  assert.equal(isManualToken(first.token), true);
  for (const value of [`mic1_${"A".repeat(43)}`, `mcm1_${"A".repeat(42)}`, `mcm1_${"A".repeat(43)}=`, null, 12]) {
    assert.equal(isManualToken(value), false, String(value));
  }
  // 연결 코드 해시와 같은 계산(sha256 hex, UTF-8)
  assert.equal(manualTokenHash(first.token), createHash("sha256").update(first.token, "utf8").digest("hex"));
});

test("상태 → 코드·HTTP: ready 말고 모든 상태에 4xx 코드가 있다", () => {
  for (const state of MANUAL_STATES) {
    const code = manualStateCode(state);
    if (state === "ready") {
      assert.equal(code, null);
      continue;
    }
    assert.ok(code, state);
    const status = ERROR_HTTP_STATUS[code];
    assert.ok(Number.isInteger(status) && status >= 400 && status < 500, `${state} → ${code} → ${status}`);
    assert.ok(MANUAL_MESSAGES[code], `${code} 문구`);
  }
  assert.deepEqual(Object.keys(MANUAL_STATE_CODES).sort(), MANUAL_STATES.filter((state) => state !== "ready").sort());
  assert.equal(ERROR_HTTP_STATUS.COUPANG_MANUAL_OFF, 403);
  assert.equal(ERROR_HTTP_STATUS.COUPANG_MANUAL_CLAIM_EXPIRED, 410);
  for (const code of Object.keys(MANUAL_MESSAGES)) {
    const status = ERROR_HTTP_STATUS[code];
    assert.ok(Number.isInteger(status) && status >= 400 && status < 500, `${code} → ${status}`);
  }
});

test("문구는 원인을 단정하지 않고(차단 '화면' 단정 없음), 오류 원문·영어를 싣지 않는다", () => {
  for (const [code, message] of Object.entries(MANUAL_MESSAGES)) {
    assert.ok(message.length > 5 && message.length < 120, code);
    assert.equal(/차단 화면이 나와|Failed|Error|error/.test(message), false, `${code}: ${message}`);
  }
  assert.match(MANUAL_MESSAGES.COUPANG_MANUAL_STOPPED, /차단으로 보이는/);
});

test("manualRefusal: 상태 거절은 코드·HTTP·사유별 문구·manual·retryAfterSec(서버 시계끼리)", () => {
  const gap = manualRefusal({ ok: false, state: "gap", manual: SUMMARY });
  assert.equal(gap.code, "COUPANG_MANUAL_GAP");
  assert.equal(gap.status, 409);
  assert.equal(gap.message, "검색과 검색 사이 간격(3분)을 기다리는 중입니다.");
  assert.equal(gap.extra.retryAfterSec, 110);
  assert.equal(gap.extra.nextAt, SUMMARY.nextAt);
  assert.equal(gap.extra.state, "gap");
  assert.equal(gap.extra.manual.extensionId, MANUAL_EXTENSION_ID);

  const hours = manualRefusal({ ok: false, state: "hours", manual: { ...SUMMARY, state: "hours", nextAt: null } });
  assert.deepEqual([hours.code, hours.status, hours.message], ["COUPANG_MANUAL_HOURS", 409, "지금 확인은 9~19시(한국 시각)에만 됩니다."]);
  assert.equal(Object.hasOwn(hours.extra, "retryAfterSec"), false);
  const cap = manualRefusal({ ok: false, state: "daily_cap", manual: { ...SUMMARY, state: "daily_cap" } });
  assert.equal(cap.message, "오늘 확인 30번을 모두 썼습니다. 내일 다시 됩니다.");
  const busy = manualRefusal({ ok: false, state: "busy", manual: { ...SUMMARY, state: "busy", busyUntil: "2026-10-23T03:02:00.000+00:00" } });
  assert.equal(busy.extra.retryAfterSec, 50);
  const off = manualRefusal({ ok: false, state: "off", manual: { ...SUMMARY, state: "off" } });
  assert.deepEqual([off.code, off.status], ["COUPANG_MANUAL_OFF", 403]);

  // 코드 거절은 코드 그대로(stopped·field 동반), 모르는 코드라도 5xx 로 새지 않는다
  const expired = manualRefusal({ ok: false, code: "COUPANG_MANUAL_CLAIM_EXPIRED", stopped: true });
  assert.deepEqual([expired.code, expired.status, expired.extra.stopped], ["COUPANG_MANUAL_CLAIM_EXPIRED", 410, true]);
  const invalid = manualRefusal({ ok: false, code: "COUPANG_MANUAL_RECORD_INVALID", field: "timing" });
  assert.deepEqual([invalid.status, invalid.extra.field], [400, "timing"]);
  const foreign = manualRefusal({ ok: false, code: "COUPANG_TRACKER_NOT_FOUND" });
  assert.deepEqual([foreign.status, foreign.message], [404, null]);
  assert.equal(manualRefusal({ ok: false, code: "COUPANG_SETUP_REQUIRED" }).status, 409);
  assert.equal(manualRefusal({ ok: false, code: "SOMETHING_NEW" }).status, 409);
  assert.equal(manualRefusal(null).code, "COUPANG_MANUAL_SETUP_REQUIRED");
});

test("manualPayload: 요약 + 상수(확장 ID·버전·zip·폴더·요청 기한), 모르는 상태·빈 값은 setup_required 만", () => {
  const payload = manualPayload(SUMMARY);
  assert.deepEqual(Object.keys(payload), [
    "state", "enabled", "usedToday", "maxPerDay", "minGapSeconds", "fromHour", "toHour", "nextAt", "busyUntil",
    "lastSearchAt", "stoppedDay", "stoppedAt", "stoppedCode", "cooldownUntil", "serverTime", "claimTtlSeconds",
    "extensionId", "extensionVersion", "minExtensionVersion", "extensionZipPath", "extensionFolder",
  ]);
  assert.deepEqual(
    [payload.extensionId, payload.extensionVersion, payload.minExtensionVersion, payload.extensionZipPath, payload.extensionFolder, payload.claimTtlSeconds],
    [MANUAL_EXTENSION_ID, MANUAL_EXTENSION_VERSION, MANUAL_MIN_EXTENSION_VERSION, MANUAL_EXTENSION_ZIP_PATH, MANUAL_EXTENSION_FOLDER, MANUAL_CLAIM_TTL_SECONDS],
  );
  assert.deepEqual(manualPayload({ state: "setup_required", serverTime: "x" }), { state: "setup_required" });
  assert.deepEqual(manualPayload({ state: "weird" }), { state: "setup_required" });
  assert.deepEqual(manualPayload(null), { state: "setup_required" });
  assert.equal(manualPayload({ state: "ready" }).usedToday, 0);
  // 계약 상수 모양
  assert.match(MANUAL_EXTENSION_ID, /^[a-p]{32}$/);
  assert.match(MANUAL_EXTENSION_VERSION, VERSION_PATTERN);
  assert.equal(MANUAL_EXTENSION_ZIP_PATH, `/coupang-check/mi-coupang-check-${MANUAL_EXTENSION_VERSION}.zip`);
  assert.equal(MANUAL_EXTENSION_FOLDER, "mi-coupang-check");
});

test("M2: 검색어가 요청 키워드와 다르면 error(query_mismatch), 대소문자·공백 차이는 같은 키워드, 차단·시간 초과·오류는 그대로", () => {
  const claim = { keyword_key: "아이폰 필름 iphone" };
  const same = ["아이폰 필름 iphone", "아이폰  필름 IPHONE", " 아이폰　필름 iPhone "];
  for (const query of same) {
    for (const status of ["ok", "noresult", "empty", "partial"]) {
      assert.deepEqual(finalManualStatus({ status }, { query }, claim), { status }, `${status} ${query}`);
    }
  }
  for (const query of ["아이폰 케이스", "", null, undefined, "a".repeat(51)]) {
    assert.deepEqual(finalManualStatus({ status: "ok" }, { query }, claim), { status: "error", errorCode: "query_mismatch" }, String(query));
  }
  for (const status of ["blocked", "timeout", "error", "unsupported"]) {
    assert.deepEqual(finalManualStatus({ status }, { query: "다른 검색어" }, claim), { status }, status);
  }
  assert.deepEqual(finalManualStatus({ status: "error", errorCode: "foreign_navigation" }, { query: "x" }, claim), { status: "error", errorCode: "foreign_navigation" });
  // 사람이 창 안을 눌러 다른 쪽으로 감 → 이동(unsupported)이 아니라 오류
  assert.deepEqual(finalManualStatus({ status: "unsupported" }, { query: "x", errorCode: "user_navigated" }, claim), { status: "error", errorCode: "user_navigated" });
  assert.deepEqual(finalManualStatus(null, {}, claim), { status: "error" });
});

test("바뀐 쿼리 이름(page.changedParams): 모양이 나쁜 원소는 거절 대신 빼고(문자열·1~40 코드 포인트·제어 문자·깨진 글자), 같은 이름 하나·10개까지", () => {
  assert.equal(manualChangedParams({}), null);
  assert.equal(manualChangedParams({ changedParams: "traceId" }), null);
  assert.equal(manualChangedParams(null), null);
  assert.deepEqual(manualChangedParams({ changedParams: [] }), []);
  assert.deepEqual(
    manualChangedParams({ changedParams: ["traceId", "", 3, null, "a\u0001b", "\ud800x", "가".repeat(41), "가".repeat(40), "traceId", " ", "채널"] }),
    ["traceId", "가".repeat(40), " ", "채널"],
  );
  const many = Array.from({ length: 15 }, (_, index) => `n${index}`);
  assert.deepEqual(manualChangedParams({ changedParams: many }), many.slice(0, 10));
});

test("바뀐 쿼리 이름을 회차 final_path 에 남긴다: user_navigated 이고 이름이 있을 때만 '경로?이름&이름'(값 없음·인코딩), 80자 안에서 이름 단위로 자르고 '&…'", () => {
  const page = (changedParams, finalPath = "/np/search") => ({ finalPath, changedParams });
  assert.equal(manualNavigatedFinalPath(page(["channel", "traceId"]), "user_navigated"), "/np/search?channel&traceId");
  assert.equal(manualNavigatedFinalPath(page(["q", "brand"]), "user_navigated"), "/np/search?q&brand");
  assert.equal(manualNavigatedFinalPath(page(["a&b", "c=d", " ", "채널"]), "user_navigated"), "/np/search?a%26b&c%3Dd&%20&%EC%B1%84%EB%84%90");
  // user_navigated 가 아니거나 이름이 없으면 경로 그대로
  assert.equal(manualNavigatedFinalPath(page(["traceId"]), "query_mismatch"), "/np/search");
  assert.equal(manualNavigatedFinalPath(page(["traceId"]), null), "/np/search");
  assert.equal(manualNavigatedFinalPath(page([]), "user_navigated"), "/np/search");
  assert.equal(manualNavigatedFinalPath({ finalPath: "/vp/products/1" }, "user_navigated"), "/vp/products/1");
  assert.equal(manualNavigatedFinalPath(null, "user_navigated"), "");
  // 80자(칸 상한) 넘으면 이름 단위로 자르고 끝에 &…
  const names = Array.from({ length: 10 }, (_, index) => `name${index}${"x".repeat(20)}`);
  const cut = manualNavigatedFinalPath(page(names), "user_navigated");
  assert.ok(cut.length <= 80, cut);
  assert.equal(cut, `/np/search?${names.slice(0, 2).join("&")}&…`);
  assert.equal(manualNavigatedFinalPath(page(["가".repeat(40)]), "user_navigated"), "/np/search?…", "인코딩한 이름 하나도 안 들어가면 ?… 만");
  const longPath = `/${"p".repeat(79)}`;
  assert.equal(manualNavigatedFinalPath(page(["a"], longPath), "user_navigated"), longPath);
  for (const count of [1, 3, 5, 10]) {
    const value = manualNavigatedFinalPath(page(Array.from({ length: count }, (_, index) => `k${index}${"y".repeat(38)}`)), "user_navigated");
    assert.ok(value.length <= 80 && value.startsWith("/np/search?"), value);
  }
});

test("그날 중지 사유: 측정은 쪽의 차단 신호, 시작 못 함은 blocked_today·report_pending 만 extension_reported, 그 밖은 없음", () => {
  assert.equal(manualRecordStopCode("measured", null, { httpStatus: 403 }), "blocked_http_403");
  assert.equal(manualRecordStopCode("measured", null, { httpStatus: 200, errorCode: "page_unreadable" }), "page_unreadable");
  assert.equal(manualRecordStopCode("measured", null, { httpStatus: 200 }), null);
  assert.equal(manualRecordStopCode("not_started", "blocked_today", null), "extension_reported");
  assert.equal(manualRecordStopCode("not_started", "report_pending", null), "extension_reported");
  assert.equal(manualRecordStopCode("not_started", "incognito_window_open", null), null);
  assert.equal(manualRecordStopCode("lost", "blocked_today", null), null);
  assert.ok(MANUAL_STOP_CODES.includes("extension_reported"));
});

test("수동 칸 감지·모듈 경계: manual_enabled 열이 있을 때만, import 는 contract·inputs·page-result·node:crypto 뿐, 시계를 읽지 않는다", () => {
  assert.equal(hasManualColumns({ manual_enabled: false }), true);
  assert.equal(hasManualColumns({ enabled: true }), false);
  assert.equal(hasManualColumns(null), false);
  const imports = [...SOURCE.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["./contract.mjs", "./inputs.mjs", "./page-result.mjs", "node:crypto"]);
  assert.equal(/Date\.now\(|new Date\(/.test(SOURCE), false, "시간 판정은 SQL(서버 시계)만 한다");
  assert.equal(SOURCE.includes("naver_"), false);
});

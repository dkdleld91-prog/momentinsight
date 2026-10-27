// C 30일 순위 ① 지금 확인 서버 도우미(manual.mjs) 검사(spec-manual §10.3).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ERROR_HTTP_STATUS,
  MANUAL_CLAIM_TTL_SECONDS,
  MANUAL_DIAGNOSTICS_MAX_BYTES,
  MANUAL_DIAGNOSTICS_NODES_MAX,
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
  manualDiagnostics,
  manualNavigatedFinalPath,
  manualPauseFields,
  manualPayload,
  manualRecordStopCode,
  kstClockOf,
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
    "lastSearchAt", "stoppedDay", "stoppedAt", "stoppedCode", "pausedUntil", "blocksToday", "blockAt", "blockCode", "pauseMinutes",
    "blocksToStop", "cooldownUntil", "serverTime", "claimTtlSeconds",
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

// ── 확장 1.0.1 실패 진단 ──
const DIAG = Object.freeze({
  v: 1, ext: "1.0.1", ok: false, code: "extract_failed",
  ms: { verified: 410, nav: 520, load: 1630, measureStart: 1710, measureEnd: 2950, end: 3010 },
  load: { how: "complete", loading: 2, complete: 2, urls: 1, completeAt: [1625, 2930] },
  retry: { tried: false, skip: "not_search" },
  tries: [{ kind: "no_result" }],
  doc: { nav: "reload", ready: "complete", title: "제목", bodyLen: 10, bodyHead: "본문", units: 0, links: 0, blocked: false, hidden: false },
});

test("manualDiagnostics: page.diagnostics(또는 맨 위 diagnostics)를 모양·크기 검사 뒤 새 객체로, 아니면 null", () => {
  const fromPage = manualDiagnostics({ page: { diagnostics: DIAG } });
  assert.deepEqual(fromPage, DIAG);
  assert.notEqual(fromPage, DIAG, "새 객체");
  assert.deepEqual(manualDiagnostics({ diagnostics: { ...DIAG, code: "page_timeout" }, page: { diagnostics: DIAG } }).code, "page_timeout", "맨 위가 먼저");
  assert.equal(manualDiagnostics({ diagnostics: null, page: { diagnostics: DIAG } }), null, "맨 위가 있으면(null 이어도) 그것만 본다");
  for (const body of [null, "x", {}, { page: null }, { page: { diagnostics: [DIAG] } }, { page: { diagnostics: "x" } }]) {
    assert.equal(manualDiagnostics(body), null, JSON.stringify(body));
  }
  const bad = [
    { ...DIAG, v: 2 }, { ...DIAG, v: "1" }, { ...DIAG, ext: "v1.0.1" }, { ...DIAG, ext: undefined }, { ...DIAG, other: 1 }, { ...DIAG, __proto__x: 1 },
    { ...DIAG, unexpected: "가".repeat(201) }, { ...DIAG, unexpected: "a\nb" }, { ...DIAG, unexpected: "\udc00" },
    { ...DIAG, ms: { ...DIAG.ms, end: Infinity } }, { ...DIAG, ms: { ...DIAG.ms, end: -2e9 } }, { ...DIAG, ms: { "1bad": 1 } }, { ...DIAG, ms: { ["k".repeat(33)]: 1 } },
    { ...DIAG, load: { ...DIAG.load, completeAt: Array.from({ length: 11 }, () => 1) } },
    { ...DIAG, doc: { a: { b: { c: 1 } } } }, { ...DIAG, doc: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`k${index}`, 1])) },
    { ...DIAG, tries: Array.from({ length: 10 }, () => ({ kind: "rejected", msg: "가".repeat(200) })) },
  ];
  for (const diagnostics of bad) assert.equal(manualDiagnostics({ page: { diagnostics } }), null, JSON.stringify(diagnostics).slice(0, 80));
  // 크기: 4KB 경계(UTF-8 바이트)
  const base = JSON.stringify({ ...DIAG, unexpected: "" });
  const room = MANUAL_DIAGNOSTICS_MAX_BYTES - Buffer.byteLength(base, "utf8");
  const fill = (bytes) => ({ ...DIAG, unexpected: "a".repeat(Math.min(200, bytes)), tries: [{ kind: "x", msg: "a".repeat(Math.max(0, Math.min(200, bytes - 200))) }] });
  assert.ok(room > 0);
  assert.notEqual(manualDiagnostics({ page: { diagnostics: fill(300) } }), null);
  const huge = { ...DIAG, tries: Array.from({ length: 8 }, () => ({ kind: "rejected", msg: "가".repeat(200) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(huge), "utf8") > MANUAL_DIAGNOSTICS_MAX_BYTES);
  assert.equal(manualDiagnostics({ page: { diagnostics: huge } }), null);
});

test("manualDiagnostics(1.0.1 검토 반영): 진단 글자의 C1 제어 문자·서식 문자(양방향·폭 없는 글자)·줄 구분을 버리고, 값 120개를 넘는 진단을 버린다", () => {
  const char = (point) => String.fromCodePoint(point);
  for (const point of [0x80, 0x85, 0x9b, 0x9f, 0xad, 0x200b, 0x200d, 0x200e, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0x2028, 0x2029, 0xe0001]) {
    for (const diagnostics of [
      { ...DIAG, unexpected: `x${char(point)}y` },
      { ...DIAG, doc: { ...DIAG.doc, title: `t${char(point)}` } },
      { ...DIAG, tries: [{ kind: "rejected", msg: `${char(point)}[31m` }] },
    ]) {
      assert.equal(manualDiagnostics({ page: { diagnostics } }), null, point.toString(16));
    }
  }
  // 보통 글자(한글·이모지·NBSP 등)와 seen(불러오는 동안 본 HTTP·차단 문구)은 그대로 받는다
  const fine = { ...DIAG, unexpected: `가😀${char(0xa0)}é`, seen: { http: 429, blocked: false } };
  assert.deepEqual(manualDiagnostics({ page: { diagnostics: fine } }), fine);
  // 검토 재현: 칸 5개 × 이름 24개 × 숫자 0 배열 10개(직렬화 4KB 이하) — jsonb 가 8KB 를 넘던 모양은 값 개수로 버린다
  const forged = { v: 1, ext: "1.0.1", ok: false, code: "x" };
  for (const key of ["ms", "load", "retry", "doc", "firstDoc"]) {
    forged[key] = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`k${index}`, Array.from({ length: 10 }, () => 0)]));
  }
  while (Buffer.byteLength(JSON.stringify(forged), "utf8") > MANUAL_DIAGNOSTICS_MAX_BYTES) {
    const keys = Object.keys(forged.firstDoc);
    if (!keys.length) break;
    delete forged.firstDoc[keys.at(-1)];
  }
  assert.ok(Buffer.byteLength(JSON.stringify(forged), "utf8") <= MANUAL_DIAGNOSTICS_MAX_BYTES);
  assert.equal(manualDiagnostics({ diagnostics: forged }), null);
  // 경계: 값 정확히 120개는 받고 121개는 버린다(맨 위 객체 1 + v·ext 2 + ms 객체 1 + 숫자 n)
  const nodes = (total) => {
    const out = { v: 1, ext: "1.0.1" };
    let left = total - 3;
    let index = 0;
    while (left > 0) {
      const box = {};
      left -= 1;
      for (let item = 0; item < 24 && left > 0; item += 1) { box[`k${item}`] = 0; left -= 1; }
      out[["ms", "load", "retry", "doc", "firstDoc", "seen"][index]] = box;
      index += 1;
    }
    return out;
  };
  assert.notEqual(manualDiagnostics({ diagnostics: nodes(MANUAL_DIAGNOSTICS_NODES_MAX) }), null);
  assert.equal(manualDiagnostics({ diagnostics: nodes(MANUAL_DIAGNOSTICS_NODES_MAX + 1) }), null);
});

// ── 차단 뒤 30분 쉼(c30-4, 2026-10-27) ──
test("c30-4 manualRefusal: paused → 409 COUPANG_MANUAL_PAUSED·pausedUntil·retryAfterSec(서버 시계끼리)·'HH:MM에 다시', 두 번째 차단 stopped 는 '두 번째' 문구, SQL 전 요약은 예전 문구", () => {
  const paused = manualRefusal({ ok: false, state: "paused", manual: { ...SUMMARY, state: "paused", serverTime: "2026-10-27T05:51:00Z", pausedUntil: "2026-10-27T06:21:00Z", blocksToday: 1 } });
  assert.deepEqual([paused.code, paused.status, paused.extra.pausedUntil, paused.extra.retryAfterSec], ["COUPANG_MANUAL_PAUSED", 409, "2026-10-27T06:21:00Z", 1800]);
  assert.match(paused.message, /30분 쉬는 중입니다\(15:21에 다시 됩니다\)/u);
  assert.match(paused.message, /한 번 더 차단되면 그날은 멈춥니다/u);
  // 18:50 첫 차단 → 쉼 끝 19:20 은 확인 시간(~19시) 밖: '19:20에 다시'가 아니라 내일 09시부터
  const late = manualRefusal({ ok: false, state: "paused", manual: { ...SUMMARY, state: "paused", fromHour: 9, toHour: 19, serverTime: "2026-10-27T09:50:00Z", pausedUntil: "2026-10-27T10:20:00Z", blocksToday: 1 } });
  assert.match(late.message, /오늘 확인 시간\(~19시\)이 끝나 내일 09시부터 다시 됩니다\.$/u);
  assert.doesNotMatch(late.message, /19:20/u);
  // 쉼 끝 시각이 없으면 고정 문구(시각을 지어내지 않는다)
  const bare = manualRefusal({ ok: false, state: "paused", manual: { ...SUMMARY, state: "paused" } });
  assert.equal(bare.message, MANUAL_MESSAGES.COUPANG_MANUAL_PAUSED);
  assert.equal(bare.extra.retryAfterSec, undefined);
  const second = manualRefusal({ ok: false, state: "stopped", manual: { ...SUMMARY, state: "stopped", blocksToday: 2 } });
  assert.match(second.message, /두 번째라 오늘은 지금 확인을 멈췄습니다\. 내일 09시부터/u);
  const legacy = manualRefusal({ ok: false, state: "stopped", manual: { ...SUMMARY, state: "stopped" } });
  assert.equal(legacy.message, MANUAL_MESSAGES.COUPANG_MANUAL_STOPPED, "SQL 전(blocksToday 없음)은 예전 문구");
  assert.equal(manualStateCode("paused"), "COUPANG_MANUAL_PAUSED");
  assert.ok(MANUAL_STATES.includes("paused"));
});

test("c30-4 manualPayload 쉼 칸·manualPauseFields·kstClockOf·확장 '쉬는 중'(blocked_pause) 시작 못 함 = 차단 알림", () => {
  const payload = manualPayload({ ...SUMMARY, state: "paused", pausedUntil: "2026-10-27T06:21:00Z", blocksToday: 1, blockAt: "2026-10-27T05:51:00Z", blockCode: "blocked_http_403", pauseMinutes: 30, blocksToStop: 2 });
  assert.deepEqual([payload.pausedUntil, payload.blocksToday, payload.blockCode, payload.pauseMinutes, payload.blocksToStop], ["2026-10-27T06:21:00Z", 1, "blocked_http_403", 30, 2]);
  const legacy = manualPayload(SUMMARY);
  assert.deepEqual([legacy.pausedUntil, legacy.blocksToday, legacy.pauseMinutes], [null, null, null], "SQL 전 요약");
  assert.deepEqual(manualPauseFields(payload), { paused: true, pausedUntil: "2026-10-27T06:21:00Z" });
  assert.deepEqual(manualPauseFields(legacy), { paused: false, pausedUntil: null });
  assert.deepEqual(manualPauseFields({ state: "setup_required" }), { paused: false, pausedUntil: null });
  assert.equal(kstClockOf("2026-10-27T06:21:00Z"), "15:21");
  assert.equal(kstClockOf("2026-10-27T15:05:00+00:00"), "00:05");
  assert.equal(kstClockOf("x"), "");
  for (const code of ["blocked_today", "blocked_pause", "report_pending"]) {
    assert.equal(manualRecordStopCode("not_started", code, null), "extension_reported", code);
  }
  assert.equal(manualRecordStopCode("not_started", "too_soon", null), null);
});

// C 30일 ① '지금 확인' 확장 — 읽은 목록 → 서버 page 모양(spec-manual §4.6).
// 나누기 규칙은 수집기 tools/coupang-rank-collector/lib/extract.mjs splitItems 와 같다(패리티 테스트).
// 판정은 서버가 한다(page-result 규칙). 여기서는 사실만 채운다: 실패해도 httpStatus·차단 문구·주소를 아는 만큼 넣는다.
import {
  BLOCKED_HTTP_STATUSES, DIAGNOSTICS_MAX_BYTES, DIAGNOSTICS_NODES_MAX, DIAGNOSTICS_SCHEMA, DIAG_BODY_HEAD_MAX, DIAG_COMPLETE_TIMES_MAX, DIAG_MS_KEYS_MAX,
  DIAG_TEXT_MAX, DIAG_TITLE_MAX, UNREADABLE_ERROR_CODE, USER_NAVIGATED_ERROR_CODE, cleanChangedParams,
} from "./protocol.js";

export const ORGANIC_MAX = 100;
export const ADS_MAX = 30;
export const SLOT_MAX = 200;
export const TITLE_MAX = 80;
export const QUERY_MAX = 100;
const PRODUCT_ID_PATTERN = /^[0-9]{4,15}$/;
const VENDOR_ITEM_PATTERN = /^[0-9]{1,20}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,60}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/g;
const LOGIN_HOST = "login.coupang.com";

// String.prototype.toWellFormed(크롬 111+)와 같은 결과: 홀로 남은 서러게이트를 U+FFFD 로 바꾼다.
export function toWellFormedText(text) {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[index] + text[index + 1];
        index += 1;
      } else {
        out += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�";
    } else {
      out += text[index];
    }
  }
  return out;
}

// 수집기 contract.mjs clipTitle 과 같다: 앞뒤 공백 제거 → 80 코드 포인트 → 깨진 글자 정리. 빈값이면 "".
export function clipTitle(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return toWellFormedText(Array.from(text).slice(0, TITLE_MAX).join(""));
}

// 위치 s 는 걸러지기 전 순서(1부터, 광고 포함). v 는 숫자 20자리까지만(아니면 빈값).
export function splitItems(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const organic = [];
  const ads = [];
  items.forEach((item, index) => {
    const s = index + 1;
    if (s > SLOT_MAX) return;
    const p = typeof item?.p === "string" ? item.p : String(item?.p ?? "");
    if (!PRODUCT_ID_PATTERN.test(p)) return;
    const vText = typeof item?.v === "string" ? item.v : String(item?.v ?? "");
    const entry = { p, v: VENDOR_ITEM_PATTERN.test(vText) ? vText : "", s };
    const t = clipTitle(item?.t);
    if (t) entry.t = t;
    if (item?.ad === true) {
      if (ads.length < ADS_MAX) ads.push(entry);
    } else if (organic.length < ORGANIC_MAX) {
      organic.push(entry);
    }
  });
  return { organic, ads, itemCount: Math.min(items.length, SLOT_MAX) };
}

function cleanHost(value) {
  const host = typeof value === "string" ? value.toLowerCase() : "";
  if (!host || host.length > 60 || /\s/.test(host) || /[\u0000-\u001f\u007f]/.test(host)) return "";
  return host;
}

function cleanPath(value) {
  let path = typeof value === "string" ? value : "";
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  path = path.slice(0, 80);
  if (/[\u0000-\u001f\u007f]/.test(path)) return "";
  return path;
}

function cleanQuery(value) {
  if (typeof value !== "string") return "";
  return toWellFormedText(Array.from(value.replace(CONTROL_PATTERN, " ")).slice(0, QUERY_MAX).join(""));
}

function httpStatusOf(value) {
  return Number.isInteger(value) && value >= 0 && value <= 599 ? value : null;
}

// raw = 쪽 함수 결과(또는 실패 때 아는 만큼의 {host, path, httpStatus, blockedText, changedParams}).
// errorCode 가 있으면 실패 회차다: 목록은 비우고(수집기와 같음), 차단 신호·주소는 남긴다.
// user_navigated 이고 쿼리만 바뀌었으면(raw.changedParams 배열) 바뀐 이름(값 없음)을 changedParams 로 싣는다 — 경로가 바뀐 이동에는 없다.
export function assemblePage(raw, { errorCode = null } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  let code = typeof errorCode === "string" && ERROR_CODE_PATTERN.test(errorCode) ? errorCode : null;
  if (!code && r.extractError === true) code = "extract_failed";
  if (!code && r.navigated === true) code = "user_navigated";
  const httpStatus = httpStatusOf(r.httpStatus);
  const blockedText = r.blockedText === true;
  const split = code ? { organic: [], ads: [], itemCount: 0 } : splitItems(r);
  const changedParams = code === USER_NAVIGATED_ERROR_CODE ? cleanChangedParams(r.changedParams) : null;
  let status;
  if (code === "page_timeout") status = "timeout";
  else if (code) status = "error";
  else status = blockedText || BLOCKED_HTTP_STATUSES.includes(httpStatus) ? "blocked" : "ok";
  return {
    status,
    httpStatus,
    loginWall: r.loginWall === true,
    stable: code ? false : r.stable === true,
    noResultText: r.noResultText === true,
    blockedText,
    itemCount: split.itemCount,
    organic: split.organic,
    ads: split.ads,
    finalHost: cleanHost(r.host),
    finalPath: cleanPath(r.path),
    errorCode: code,
    query: cleanQuery(r.query),
    wasHidden: r.wasHidden === true,
    ...(changedParams ? { changedParams } : {}),
  };
}

// 확장이 보는 '그날 중지' 사유. 서버 page-result manualStopSignal 과 같은 순서·같은 코드다(테스트):
// HTTP 403·429·503 → 차단 문구 → 차단 판정 → 로그인 화면 → 읽을 수 없는 곳으로 보내짐(D1). 신호가 없으면 null.
// 광고만 있고 일반 0개(empty)·결과 없음·시간 초과(차단 HTTP 없음)·사람이 닫음·상품 누름은 넣지 않는다.
export function stopReasonOf(page) {
  if (!page || typeof page !== "object") return null;
  const httpStatus = page.httpStatus === undefined ? null : page.httpStatus;
  if (BLOCKED_HTTP_STATUSES.includes(httpStatus)) return `blocked_http_${httpStatus}`;
  if (page.blockedText === true) return "blocked_text";
  if (page.status === "blocked") return "blocked_page";
  const host = typeof page.finalHost === "string" ? page.finalHost.toLowerCase() : "";
  const path = typeof page.finalPath === "string" ? page.finalPath : "";
  if (host === LOGIN_HOST || (/(^|\.)coupang\.com$/.test(host) && path.startsWith("/login"))) return "login_redirect";
  if (page.errorCode === UNREADABLE_ERROR_CODE) return "page_unreadable";
  return null;
}

export function isStopSignal(page) {
  return stopReasonOf(page) !== null;
}

// ── 실패 진단(1.0.1) ── 결과 page.diagnostics 에 싣는 짧은 기록(서버가 모양·크기를 다시 보고 회차 diagnostics 칸에 따로 둔다).
// 개인 정보 없음: 주소는 쿼리·# 를 떼고(호스트·경로만), 글자는 제어 문자·연속 공백을 공백 하나로, 칸마다 길이 상한.
// 직렬화(UTF-8) 4KB 를 넘으면 본문 앞부분 → 제목 → 오류 문구 → load 시각 순으로 덜어 내고 cut:true 를 단다.
// 성공(오류 코드 없음·차단 아님)이면 짧게: 경과 ms·load 횟수·재시도 여부만(재시도했으면 시도 종류도).
const DIAG_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const DIAG_WORD_PATTERN = /^[a-z0-9_]{1,40}$/;
const DIAG_MS_MAX = 600000;
const DIAG_COUNT_MAX = 1000000;
const DIAG_TRIES_MAX = 4;
// 진단 글자에서 지우는 것(1.0.1 검토 반영 — SQL 결과를 터미널·편집기로 볼 때 표시가 뒤틀리지 않게):
// 제어 문자 전부(C0·DEL·C1 = 유니코드 Cc)는 공백으로, 서식 문자(양방향 재정렬 U+202A~202E·U+2066~2069, 폭 없는 글자 U+200B~200D·U+2060,
// BOM U+FEFF 등 = 유니코드 Cf)는 없앤다. 줄·문단 구분(U+2028·2029) 같은 나머지 공백은 아래에서 공백 하나로 모은다.
// 서버 진단 검사(manual.mjs)는 이 글자들(Cc·Cf·U+2028·2029)이 든 진단을 버린다 — 같은 규칙(서버 대조 테스트).
const DIAG_CONTROL_PATTERN = /\p{Cc}/gu;
const DIAG_FORMAT_PATTERN = /\p{Cf}/gu;
// 주소처럼 보이는 낱말(공백·따옴표·<> 로 나뉜 덩어리)은 호스트·경로만 남긴다: 사용자 정보(user:pass@ — 아래처럼 글 전체에서 먼저 지움)를 빼고 첫 ? # ;
// (%3F·%23·%3B 포함, data: 주소는 , 도) 앞까지만. 주소처럼 보인다 = scheme://(또는 %3A%2F%2F)가 들었거나, / 가 들었거나,
// 점 든 호스트 바로 뒤에 ? # ; 가 오거나, data: 가 든 낱말 — scheme 없는 주소·;jsessionid= 같은 경로 매개변수도 뗀다.
// 사용자 정보(1.0.1 재검사 반영 — 어떤 모양이든): 낱말로 나누기 전에, 글 전체에서 @(또는 %40)와 그 바로 앞 덩어리(공백·/·?·#·%3F·%23
// 까지 — 따옴표·;·제어 문자가 든 것도)를 지운다. scheme 있는 주소(https://user:pw@host)·scheme 없는 주소(user:pw@host/a)·
// // 로 시작하는 주소(//user:pw@host)·인코딩된 주소(https%3A%2F%2Fuser%3Apw%40host) 모두 호스트부터 남고, 진단 글자에는 @·%40 이
// 하나도 남지 않는다(전자우편 앞부분·경로 안의 @ 앞 덩어리도 함께 지움 — 더 지우는 쪽). 쿼리 안의 @ 는 쿼리 안에서만 지운다(? 에서 멈춤).
const ADDRESS_WORD_PATTERN = /[^\s"'<>]+/g;
const ADDRESS_LIKE_PATTERN = /[a-z][a-z0-9+.-]*:\/\/|%3a%2f%2f|\/|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::[0-9]{1,5})?[?#;]|data:/i;
// 덩어리는 경계(글 처음·공백·/ ? # @ 와 %3F %23 %40 바로 뒤)에서만 시작한다(인코딩 글자 %3F 의 중간에서 시작해 앞 주소를 지우지 않게).
// 덩어리 안의 %3F·%23 에서는 멈추지 않는다: 크롬은 사용자 정보의 ?·# 를 %3F·%23 으로 쓰므로 거기서 멈추면 앞부분(비밀번호 앞)이 남는다
// (1.0.1 재검사 4차). 그래서 인코딩된 쿼리 안의 %40 이면 호스트까지 지워진다 — 더 지우는 쪽.
const USERINFO_PATTERN = /(?<=^|[\s/?#@]|%3f|%23|%40)[^\s/?#@]*(?:@|%40)/gi;
const ADDRESS_CUT_PATTERN = /[?#;]|%3f|%23|%3b/i;
const DATA_CUT_PATTERN = /[?#;,]|%3f|%23|%3b/i;
// 다듬기 전 입력 상한(UTF-16 단위). 결과는 200 코드 포인트 이하라 충분하고, 아주 긴 글(크롬 오류 문구 안의 긴 주소 등)에서
// 주소 정규식이 오래 돌지 않게 한다(1.0.1 재검사 중 실측: 상한 없이 10만 자면 13초 남짓).
const DIAG_INPUT_MAX = 2000;

function addressWord(word) {
  if (!ADDRESS_LIKE_PATTERN.test(word)) return word;
  const cut = /data:/i.test(word) ? word.search(DATA_CUT_PATTERN) : word.search(ADDRESS_CUT_PATTERN);
  return cut >= 0 ? word.slice(0, cut) : word;
}

// 상한에서 자르면 끝 낱말은 잘린 조각이라 버린다: 'user:SECRET@' 가운데가 잘리면 @ 가 없어져 사용자 정보로 알아보지 못하고 앞부분이
// 남는다(1.0.1 재검사 4차). 낱말 = 공백·따옴표·<> 가 아닌 글자의 이어짐(주소 낱말과 같은 기준).
function diagnosticInput(value) {
  const text = String(value);
  if (text.length <= DIAG_INPUT_MAX) return text;
  return text.slice(0, DIAG_INPUT_MAX).replace(/[^\s"'<>]*$/u, "");
}

export function diagnosticText(value, max = DIAG_TEXT_MAX) {
  if (value === null || value === undefined) return "";
  const text = toWellFormedText(diagnosticInput(value))
    .replace(USERINFO_PATTERN, "")
    .replace(DIAG_CONTROL_PATTERN, " ")
    .replace(DIAG_FORMAT_PATTERN, "")
    .replace(ADDRESS_WORD_PATTERN, addressWord)
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, Math.max(0, Math.min(max, DIAG_TEXT_MAX))).join("");
}

function diagMs(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(DIAG_MS_MAX, Math.round(value))) : null;
}

function diagCount(value) {
  return Number.isInteger(value) && value >= 0 ? Math.min(DIAG_COUNT_MAX, value) : 0;
}

function diagWord(value) {
  return typeof value === "string" && DIAG_WORD_PATTERN.test(value) ? value : null;
}

function diagDoc(doc) {
  if (!doc || typeof doc !== "object") return null;
  return {
    nav: diagWord(doc.nav),
    ready: diagWord(doc.ready),
    title: diagnosticText(doc.title, DIAG_TITLE_MAX),
    bodyLen: diagCount(doc.bodyLen),
    bodyHead: diagnosticText(doc.bodyHead, DIAG_BODY_HEAD_MAX),
    units: diagCount(doc.units),
    links: diagCount(doc.links),
    blocked: doc.blocked === true,
    hidden: doc.hidden === true,
  };
}

export function diagnosticsBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// 값 개수(객체·배열·글자·수·참거짓·null 모두 1개씩). 서버는 이 개수도 본다(jsonb 칸 크기가 8KB 제약을 넘지 않게).
export function diagnosticsNodes(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + diagnosticsNodes(item), 1);
  if (value && typeof value === "object") return Object.values(value).reduce((sum, item) => sum + diagnosticsNodes(item), 1);
  return 1;
}

function diagnosticsFit(value) {
  return diagnosticsBytes(value) <= DIAGNOSTICS_MAX_BYTES && diagnosticsNodes(value) <= DIAGNOSTICS_NODES_MAX;
}

// input = { version, page, ms:{이름: ms}, load:{how, loading, complete, urls, completeAt[]}, tries:[{kind, msg}], doc(마지막 쪽 모양),
//           firstDoc(불러온 직후 쪽 모양), retry:{tried, skip, load, result}, hidden, unexpected, seen:{httpStatus, blockedText, lastHttpStatus} }.
// 돌려주는 값은 JSON 그대로 보낼 수 있는 새 객체(4KB·값 DIAGNOSTICS_NODES_MAX 개 이하, 맨 위 칸은 DIAGNOSTICS_TOP_KEYS 안).
// firstDoc 은 실패이고 doc 과 다른 읽기일 때만 싣는다. seen 은 실패 때만: http = 불러오는 동안·짧은 읽기에서 본 HTTP 상태(차단 값은
// 한 번 보면 남음 = 본 차단 HTTP), blocked = 본 차단 문구, last = 마지막으로 읽은 문서 자신의 HTTP(측정 포함, 차단 값으로 바꾸지 않음 —
// 결과 httpStatus 는 차단 쪽을 우선하므로 '중간 문서만 429·최종 문서 200' 과 '최종 문서 429' 를 이 값으로 가린다). 모르면 null.
export function buildDiagnostics(input) {
  const source = input && typeof input === "object" ? input : {};
  const page = source.page && typeof source.page === "object" ? source.page : {};
  const code = typeof page.errorCode === "string" && ERROR_CODE_PATTERN.test(page.errorCode) ? page.errorCode : null;
  const success = !code && page.status !== "blocked";
  const ms = {};
  for (const [name, value] of Object.entries(source.ms && typeof source.ms === "object" ? source.ms : {})) {
    const at = diagMs(value);
    if (DIAG_KEY_PATTERN.test(name) && at !== null && Object.keys(ms).length < DIAG_MS_KEYS_MAX) ms[name] = at;
  }
  const loadSource = source.load && typeof source.load === "object" ? source.load : {};
  const load = {
    how: diagWord(loadSource.how),
    loading: diagCount(loadSource.loading),
    complete: diagCount(loadSource.complete),
    urls: diagCount(loadSource.urls),
    completeAt: (Array.isArray(loadSource.completeAt) ? loadSource.completeAt : []).map(diagMs).filter((at) => at !== null).slice(0, DIAG_COMPLETE_TIMES_MAX),
  };
  const retrySource = source.retry && typeof source.retry === "object" ? source.retry : {};
  const retry = { tried: retrySource.tried === true };
  if (diagWord(retrySource.skip)) retry.skip = retrySource.skip;
  if (diagWord(retrySource.load)) retry.load = retrySource.load;
  if (diagWord(retrySource.result)) retry.result = retrySource.result;
  const tries = (Array.isArray(source.tries) ? source.tries : []).slice(0, DIAG_TRIES_MAX).map((entry) => {
    const out = { kind: diagWord(entry?.kind) || "unknown" };
    const msg = diagnosticText(entry?.msg);
    if (msg) out.msg = msg;
    return out;
  });
  const out = { v: DIAGNOSTICS_SCHEMA, ext: String(source.version || ""), ok: success, code, ms, load, retry };
  if (!success || retry.tried) out.tries = tries;
  if (!success) {
    const doc = diagDoc(source.doc);
    if (doc) out.doc = doc;
    const firstDoc = source.firstDoc && source.firstDoc !== source.doc ? diagDoc(source.firstDoc) : null;
    if (firstDoc) out.firstDoc = firstDoc;
    out.hidden = source.hidden === true || page.wasHidden === true;
    const unexpected = diagnosticText(source.unexpected);
    if (unexpected) out.unexpected = unexpected;
    if (source.seen && typeof source.seen === "object") {
      out.seen = { http: httpStatusOf(source.seen.httpStatus), blocked: source.seen.blockedText === true, last: httpStatusOf(source.seen.lastHttpStatus) };
    }
  }
  // 4KB·값 개수 상한: 덜 중요한 것부터 덜어 낸다.
  const steps = [
    (value) => { delete value.firstDoc; },
    (value) => { if (value.doc) delete value.doc.bodyHead; },
    (value) => { if (value.doc) delete value.doc.title; },
    (value) => { if (Array.isArray(value.tries)) value.tries = value.tries.map((entry) => ({ kind: entry.kind })); delete value.unexpected; },
    (value) => { value.load.completeAt = []; },
  ];
  for (const step of steps) {
    if (diagnosticsFit(out)) return out;
    step(out);
    out.cut = true;
  }
  if (diagnosticsFit(out)) return out;
  return { v: DIAGNOSTICS_SCHEMA, ext: out.ext, ok: out.ok, code: out.code, cut: true };
}

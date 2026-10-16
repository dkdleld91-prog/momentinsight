// C 30일 순위 화면 API 입력 정규화(명세 §5.8, WP2). 화면 API 핸들러만 import 한다.
// 모든 함수는 던지지 않고 결과 객체를 돌려준다.
// - 성공: { ok: true, ... }
// - 실패: { ok: false, code }   (code 는 §3.4 의 화면 API 코드. 문구는 핸들러가 붙인다)
import { BULK_IDS_MAX, DEFAULT_GROUP, GROUP_MAX, KEYWORD_KEY_CASE_FOLD, KEYWORD_MAX } from "./contract.mjs";

const PRODUCT_ID_PATTERN = /^[0-9]{4,15}$/;
const VENDOR_ITEM_ID_PATTERN = /^[0-9]{1,20}$/;
const PRODUCT_PATH_PATTERN = /^\/(?:vp|vm)\/products\/([0-9]{4,15})\/?$/;
const COUPANG_PRODUCT_HOSTS = new Set(["coupang.com", "www.coupang.com", "m.coupang.com"]);
const SHORT_LINK_HOSTS = new Set(["link.coupang.com", "coupa.ng"]);
// 앞에 https:// 를 붙여 주소로 읽는 입력(§5.8 표). 짧은 링크 호스트는 거절 코드를 정확히 주려고 함께 본다.
const SCHEMELESS_PREFIX_PATTERN = /^(?:www\.|(?:m\.coupang\.com|coupang\.com|link\.coupang\.com|coupa\.ng)(?:[/?#:]|$))/i;
const URL_IN_KEYWORD_PATTERN = /^https?:\/\//i;
const COUPANG_PATH_IN_KEYWORD_PATTERN = /coupang\.com\//i;
// 공백류(전각 U+3000·탭·줄바꿈 포함)는 한 칸으로 바꾼다. 그 밖의 제어 문자는 저장하지 않는다.
const WHITESPACE_PATTERN = /\s+/gu;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function textInput(value) {
  if (value === null || value === undefined) return { ok: true, text: "" };
  if (typeof value === "string") return { ok: true, text: value };
  if (typeof value === "number" && Number.isFinite(value)) return { ok: true, text: String(value) };
  return { ok: false, text: "" };
}

function squash(text) {
  return text.normalize("NFC").replace(WHITESPACE_PATTERN, " ").trim();
}

// DB char_length 와 같은 기준(코드 포인트)으로 센다.
function codePointLength(text) {
  return Array.from(text).length;
}

function wellFormed(text) {
  return typeof text.isWellFormed === "function" ? text.isWellFormed() : !/[\ud800-\udfff]/u.test(text);
}

// 키워드: NFC → 공백류를 한 칸으로 → trim. 비면 REQUIRED, 50자 초과·주소 모양이면 INVALID.
export function normalizeCoupangKeyword(value) {
  const input = textInput(value);
  if (!input.ok) return { ok: false, code: "COUPANG_KEYWORD_INVALID" };
  if (!wellFormed(input.text)) return { ok: false, code: "COUPANG_KEYWORD_INVALID" };
  const keyword = squash(input.text);
  if (!keyword) return { ok: false, code: "COUPANG_KEYWORD_REQUIRED" };
  if (codePointLength(keyword) > KEYWORD_MAX) return { ok: false, code: "COUPANG_KEYWORD_INVALID" };
  if (CONTROL_PATTERN.test(keyword)) return { ok: false, code: "COUPANG_KEYWORD_INVALID" };
  if (URL_IN_KEYWORD_PATTERN.test(keyword) || COUPANG_PATH_IN_KEYWORD_PATTERN.test(keyword)) {
    return { ok: false, code: "COUPANG_KEYWORD_INVALID" };
  }
  // 소문자로 바꾸면 길이가 늘어나는 글자가 있다(예: 'İ'). 키워드 열쇠도 DB 상한(50) 안이어야 한다.
  if (codePointLength(coupangKeywordKey(keyword)) > KEYWORD_MAX) return { ok: false, code: "COUPANG_KEYWORD_INVALID" };
  return { ok: true, value: keyword };
}

// 키워드 열쇠(같은 키워드는 검색 1회를 공유). 0단계에서 대소문자 차이가 확인되면 상수만 false 로 바꾼다.
export function coupangKeywordKey(keyword) {
  const text = String(keyword ?? "");
  return KEYWORD_KEY_CASE_FOLD ? text.toLowerCase() : text;
}

// 상품 입력: 상품번호(4~15자리) 또는 쿠팡 상품 페이지 주소.
// 성공: { ok: true, productId, vendorItemId | null, productUrl: "https://www.coupang.com/vp/products/<id>" }
export function parseCoupangProductInput(value) {
  const input = textInput(value);
  if (!input.ok) return { ok: false, code: "COUPANG_NOT_PRODUCT_URL" };
  const text = input.text.trim();
  if (!text) return { ok: false, code: "COUPANG_PRODUCT_URL_REQUIRED" };
  if (PRODUCT_ID_PATTERN.test(text)) return productResult(text, null);

  // www. 로 시작하면 쿠팡이 아니어도 표대로 https:// 를 붙인다(아래 호스트 검사에서 거절된다).
  const candidate = SCHEMELESS_PREFIX_PATTERN.test(text) ? `https://${text}` : text;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, code: "COUPANG_NOT_PRODUCT_URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, code: "COUPANG_NOT_PRODUCT_URL" };
  const host = url.hostname.toLowerCase();
  if (SHORT_LINK_HOSTS.has(host)) return { ok: false, code: "COUPANG_SHORT_LINK_UNSUPPORTED" };
  if (!COUPANG_PRODUCT_HOSTS.has(host)) return { ok: false, code: "COUPANG_NOT_PRODUCT_URL" };
  if (url.username || url.password || url.port) return { ok: false, code: "COUPANG_NOT_PRODUCT_URL" };
  const match = PRODUCT_PATH_PATTERN.exec(url.pathname);
  if (!match) return { ok: false, code: "COUPANG_NOT_PRODUCT_URL" };
  const vendorItemId = url.searchParams.get("vendorItemId");
  return productResult(match[1], vendorItemId && VENDOR_ITEM_ID_PATTERN.test(vendorItemId) ? vendorItemId : null);
}

function productResult(productId, vendorItemId) {
  return {
    ok: true,
    productId,
    vendorItemId,
    productUrl: `https://www.coupang.com/vp/products/${productId}`,
  };
}

// 그룹 이름: NFC → 공백 한 칸 → trim. 비면 '기본 그룹', 30자 초과면 GROUP_INVALID.
export function normalizeCoupangGroupName(value) {
  const input = textInput(value);
  if (!input.ok) return { ok: false, code: "COUPANG_GROUP_INVALID" };
  if (!wellFormed(input.text)) return { ok: false, code: "COUPANG_GROUP_INVALID" };
  const name = squash(input.text);
  if (!name) return { ok: true, value: DEFAULT_GROUP };
  if (codePointLength(name) > GROUP_MAX || CONTROL_PATTERN.test(name)) return { ok: false, code: "COUPANG_GROUP_INVALID" };
  return { ok: true, value: name };
}

// 본문의 ids(배열) 또는 id(하나)를 uuid 목록으로. 소문자로 맞추고 중복을 지운 뒤 1~100개여야 한다.
export function parseIdList(body) {
  const source = body && typeof body === "object" ? body : {};
  let raw;
  if (source.ids !== undefined && source.ids !== null) {
    if (!Array.isArray(source.ids)) return { ok: false, code: "COUPANG_IDS_INVALID" };
    raw = source.ids;
  } else if (source.id !== undefined && source.id !== null) {
    raw = [source.id];
  } else {
    return { ok: false, code: "COUPANG_IDS_INVALID" };
  }
  const ids = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string" || !UUID_PATTERN.test(item)) return { ok: false, code: "COUPANG_IDS_INVALID" };
    const id = item.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length < 1 || ids.length > BULK_IDS_MAX) return { ok: false, code: "COUPANG_IDS_INVALID" };
  return { ok: true, ids };
}

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// 순위 추적 등록 시 상품 URL 형태 검증(F13).
//
// 왜 필요한가: 상품 식별자 추출(naver-shopping-rank.mjs:149-159)은 신뢰 호스트의
// 경로에서 8자리 이상 숫자를 마지막 수단으로 집는다. 이 폴백은 윈도우 상품처럼
// /products/ 를 쓰지 않는 정상 URL 을 살리려고 있는 것인데, 카테고리·검색·기획전
// URL 의 숫자까지 같이 집어서 "영원히 못 찾는 product 모드 추적기"를 만든다.
// 그 행은 한도만 먹고 수집 용량을 계속 소모하므로 등록 시점에 걸러야 한다.
//
// 판정 순서가 안전장치다. 정식 상품·원부 경로를 먼저 통과시키므로, 금지 낱말이
// 경로 어딘가에 섞여 있어도 정상 등록 형태는 절대 막히지 않는다.

export const RANK_PRODUCT_URL_REJECTION_MESSAGE = "상품 URL 또는 원부(카탈로그) URL을 입력해주세요.";
export const RANK_PRODUCT_URL_REJECTION_CODE = "RANK_PRODUCT_URL_UNSUPPORTED";

// 상품이 아닌 목록·검색·기획전 경로에서만 쓰이는 낱말. 경로 조각이 이 값과 같을 때만
// 막는다(호스트는 보지 않는다 — search.shopping.naver.com/catalog/… 는 정상 원부 URL).
export const RANK_PRODUCT_URL_DENIED_SEGMENTS = Object.freeze([
  "category",
  "categories",
  "search",
  "searchall",
  "plan",
  "planning",
  "event",
  "events",
  "exhibition",
  "promotion",
  "promotions",
  "display",
  "best",
  "hotdeal",
  "benefit",
]);

const DENIED_SEGMENTS = new Set(RANK_PRODUCT_URL_DENIED_SEGMENTS);
const CANONICAL_PRODUCT_PATH = /\/(?:products|product|catalog)\/[0-9]{5,}(?:[/?#]|$)/i;
const TRAILING_NUMERIC_PATH = /\/[0-9]{8,}(?:[/?#]|$)/;

function parseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

// naver-shopping-rank.mjs 의 isTrustedNaverShoppingProductHost 와 같은 집합.
// 이 목록이 갈라지면 서버는 식별자를 뽑는데 등록은 막히는(또는 그 반대) 상태가 된다.
function isTrustedNaverShoppingProductHost(value) {
  const host = String(value || "").trim().toLowerCase();
  return host === "smartstore.naver.com"
    || host === "m.smartstore.naver.com"
    || host === "brand.naver.com"
    || host === "shopping.naver.com"
    || host.endsWith(".shopping.naver.com");
}

function decodedPath(parsed) {
  try {
    return decodeURIComponent(parsed.pathname || "");
  } catch {
    return String(parsed.pathname || "");
  }
}

// index.naver / plan2 처럼 확장자·숫자가 붙은 조각도 같은 낱말로 본다.
function normalizeSegment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[0-9]+$/, "")
    .replace(/[^a-z]/g, "");
}

export function rankProductUrlShape(value) {
  const parsed = parseUrl(value);
  // URL 이 아니거나 신뢰 호스트가 아니면 여기서 판정하지 않는다. 단축링크(naver.me)
  // 처럼 숫자 상품ID 를 함께 넣어 등록하던 형태를 막지 않기 위해서다. 식별자가
  // 없으면 기존 게이트(hasDirectTarget)가 그대로 400 을 돌려준다.
  if (!parsed) return { ok: true, kind: "not-a-url" };
  if (!isTrustedNaverShoppingProductHost(parsed.hostname)) return { ok: true, kind: "untrusted-host" };

  const path = decodedPath(parsed);
  if (CANONICAL_PRODUCT_PATH.test(path)) return { ok: true, kind: "canonical" };

  const denied = path.split("/").map(normalizeSegment).find((segment) => DENIED_SEGMENTS.has(segment));
  if (denied) return { ok: false, kind: "listing-path", segment: denied };

  // 윈도우 상품(/window-products/style/12345678)처럼 정식 경로를 쓰지 않는 상품 URL.
  if (TRAILING_NUMERIC_PATH.test(path)) return { ok: true, kind: "numeric-path" };

  return { ok: true, kind: "no-path-id" };
}

// 막아야 하면 안내 문구를, 통과시키면 빈 문자열을 돌려준다.
export function rankProductUrlRejection(value) {
  return rankProductUrlShape(value).ok ? "" : RANK_PRODUCT_URL_REJECTION_MESSAGE;
}

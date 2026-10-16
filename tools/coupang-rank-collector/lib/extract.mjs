// 쪽 안에서 실행하는 읽기 함수 원문(명세 §9.2 lib/extract.mjs)과 결과 나누기. 화면을 바꾸지 않고, 상품을 클릭하지 않는다.
// 광고는 링크의 sourceType=srp_product_ads 로 가른다(2026-10-13 실측). 순위는 서버(SQL)가 센다.
import { ADS_MAX, AD_SOURCE_TYPE, ORGANIC_MAX, SLOT_MAX, clipTitle } from "./contract.mjs";

export const EXTRACT_SOURCE = `(() => {
  const body = document.body ? document.body.innerText : "";
  const lis = Array.from(document.querySelectorAll('li[class*="ProductUnit"]'));
  const items = [];
  lis.forEach((li) => {
    const a = li.querySelector('a[href*="/vp/products/"]');
    if (!a) return;
    const u = new URL(a.href);
    items.push({
      p: (u.pathname.match(/products\\/(\\d+)/) || [])[1] || "",
      v: u.searchParams.get("vendorItemId") || "",
      ad: (u.searchParams.get("sourceType") || "") === "srp_product_ads",
      t: ((li.innerText || "").split("\\n")[0] || "").trim().slice(0, 200)
    });
  });
  return JSON.stringify({
    host: location.host.toLowerCase(),
    path: location.pathname.slice(0, 80),
    blockedText: /Access Denied|permission to access|비정상적인 접근|자동입력 방지|captcha/i.test(body.slice(0, 4000)) || /Access Denied/i.test(document.title),
    noResultText: /검색결과가 없습니다/.test(body),
    loginWall: /로그인하고 더 많은 상품/.test(body),
    items
  });
})()`;

// 쪽 함수 원문의 광고 표식이 계약 값과 같은지 테스트가 확인한다.
export const EXTRACT_AD_SOURCE_TYPE = AD_SOURCE_TYPE;

const PRODUCT_ID_PATTERN = /^[0-9]{4,15}$/;
const VENDOR_ITEM_PATTERN = /^[0-9]{1,20}$/;

export class ExtractError extends Error {
  constructor(message) {
    super(message || "extract_failed");
    this.code = "extract_failed";
  }
}

// 쪽 함수가 돌려준 JSON 문자열을 해석한다. 모양이 틀리면 extract_failed.
export function parseExtractResult(value) {
  if (typeof value !== "string") throw new ExtractError("extract_not_string");
  let raw;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new ExtractError("extract_json");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) throw new ExtractError("extract_shape");
  return {
    host: typeof raw.host === "string" ? raw.host.toLowerCase().slice(0, 60) : "",
    path: typeof raw.path === "string" ? raw.path.slice(0, 80) : "",
    blockedText: raw.blockedText === true,
    noResultText: raw.noResultText === true,
    loginWall: raw.loginWall === true,
    items: raw.items,
  };
}

// 위치 s 는 걸러지기 전 순서(1부터, 광고 포함). v 는 숫자 20자리까지만(아니면 빈값). 제목은 80 코드 포인트로 다듬고 빈값이면 뺀다.
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

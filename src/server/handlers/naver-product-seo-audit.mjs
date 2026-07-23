import { isLocalRequest, protectedJson } from "../security.mjs";

const ALLOWED_HOSTS = new Set([
  "smartstore.naver.com",
  "m.smartstore.naver.com",
  "brand.naver.com",
  "m.brand.naver.com",
]);
const SEO_AUDIT_TIMEOUT_MS = Number(process.env.MI_SEO_AUDIT_TIMEOUT_MS || 8_000);
const SEO_AUDIT_MAX_BYTES = Number(process.env.MI_SEO_AUDIT_MAX_BYTES || 1_200_000);
const SEO_AUDIT_CACHE_TTL_MS = Number(process.env.MI_SEO_AUDIT_CACHE_TTL_MS || 1000 * 60 * 10);
const SEO_AUDIT_CACHE_MAX = Number(process.env.MI_SEO_AUDIT_CACHE_MAX || 200);
const SEO_AUDIT_RATE_WINDOW_MS = Number(process.env.MI_SEO_AUDIT_RATE_WINDOW_MS || 60_000);
const SEO_AUDIT_RATE_LIMIT = Number(process.env.MI_SEO_AUDIT_RATE_LIMIT || 20);
const auditCache = new Map();
const auditRateBucket = new Map();

function text(value) {
  return String(value == null ? "" : value).trim();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function clientRateKey(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim() || request.headers.get("x-real-ip") || "anonymous";
}

function checkRateLimit(request) {
  if (isLocalRequest(request)) return { allowed: true };
  const now = Date.now();
  const key = clientRateKey(request);
  const fresh = (auditRateBucket.get(key) || []).filter((time) => now - time < SEO_AUDIT_RATE_WINDOW_MS);
  if (fresh.length >= SEO_AUDIT_RATE_LIMIT) {
    auditRateBucket.set(key, fresh);
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((SEO_AUDIT_RATE_WINDOW_MS - (now - fresh[0])) / 1000)),
    };
  }
  fresh.push(now);
  auditRateBucket.set(key, fresh);
  if (auditRateBucket.size > 1000) {
    for (const [bucketKey, times] of auditRateBucket.entries()) {
      const active = times.filter((time) => now - time < SEO_AUDIT_RATE_WINDOW_MS);
      if (active.length) auditRateBucket.set(bucketKey, active);
      else auditRateBucket.delete(bucketKey);
    }
  }
  return { allowed: true };
}

export function normalizeProductUrl(value) {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    throw new Error("올바른 네이버 상품 URL을 입력해주세요.");
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("네이버 스마트스토어 또는 브랜드스토어 상품 URL만 확인할 수 있습니다.");
  }
  const match = url.pathname.match(/^\/([^/]+)\/products\/(\d+)(?:\/)?$/);
  if (!match) throw new Error("상품 번호가 포함된 네이버 상품 URL을 입력해주세요.");
  const store = match[1];
  const productId = match[2];
  const mobileHost = url.hostname.toLowerCase().includes("brand.naver.com")
    ? "m.brand.naver.com"
    : "m.smartstore.naver.com";
  return {
    url: `https://${mobileHost}/${encodeURIComponent(store)}/products/${productId}`,
    store,
    productId,
    host: mobileHost,
  };
}

function jsonSafeJavascriptLiteral(value) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (value.startsWith("undefined", index) && !/[A-Za-z0-9_$]/.test(value[index - 1] || "") && !/[A-Za-z0-9_$]/.test(value[index + 9] || "")) {
      output += "null";
      index += 8;
      continue;
    }
    output += character;
  }
  return output;
}

function extractPreloadedState(html) {
  const match = text(html).match(/window\.__PRELOADED_STATE__=([\s\S]*?)<\/script>/i);
  if (!match) throw new Error("네이버 상품 공개 정보를 확인하지 못했습니다.");
  try {
    return JSON.parse(jsonSafeJavascriptLiteral(match[1]));
  } catch {
    throw new Error("네이버 상품 정보 형식이 변경되어 자동 점검이 필요합니다.");
  }
}

function unavailable(label, evidence) {
  return {
    verified: false,
    state: "",
    label,
    evidence,
  };
}

function positiveReviewPoint(benefitsView) {
  const keys = [
    "generalPurchaseReviewPoint",
    "premiumPurchaseReviewPoint",
    "storeMemberReviewPoint",
    "textReviewPoint",
    "photoVideoReviewPoint",
    "afterUseTextReviewPoint",
    "afterUsePhotoVideoReviewPoint",
    "managerGeneralPurchaseReviewPoint",
    "managerPremiumPurchaseReviewPoint",
    "managerTextReviewPoint",
    "managerPhotoVideoReviewPoint",
  ];
  const values = keys.map((key) => finiteNumber(benefitsView?.[key])).filter((value) => value !== null);
  return {
    configured: values.length > 0,
    maxPoint: values.length ? Math.max(...values) : 0,
  };
}

export function parseNaverProductSeoHtml(html, expectedProductId = "") {
  const state = extractPreloadedState(html);
  const product = state?.simpleProductForDetailPage?.A;
  if (!product || !product.id) throw new Error("네이버 상품 공개 정보를 확인하지 못했습니다.");
  if (expectedProductId && String(product.id) !== String(expectedProductId)) {
    throw new Error("입력한 URL과 공개 상품 정보가 일치하지 않습니다.");
  }

  const reviewCount = finiteNumber(product.reviewAmount?.totalReviewCount);
  const benefitsView = product.benefitsView && typeof product.benefitsView === "object"
    ? product.benefitsView
    : null;
  const discountRatio = finiteNumber(benefitsView?.dispDiscountedRatio ?? benefitsView?.discountedRatio);
  const discountAmount = finiteNumber(benefitsView?.sellerImmediateDiscountAmount);
  const discountedPrice = finiteNumber(benefitsView?.dispDiscountedSalePrice ?? benefitsView?.discountedSalePrice);
  const discountConfigured = Boolean(
    benefitsView &&
    (discountRatio !== null || discountAmount !== null || discountedPrice !== null)
  );
  const discountApplied = Boolean(
    (discountRatio || 0) > 0 ||
    (discountAmount || 0) > 0 ||
    (discountedPrice !== null && finiteNumber(product.salePrice) !== null && discountedPrice < Number(product.salePrice))
  );
  const reviewPoint = positiveReviewPoint(benefitsView);
  const detailRegistered = Boolean(product.detailContents?.editorType);

  const signals = {
    review: reviewCount === null
      ? unavailable("자동 확인 불가", "공개 상품 화면에 리뷰 수가 제공되지 않았습니다.")
      : {
          verified: true,
          value: reviewCount,
          label: `${reviewCount.toLocaleString("ko-KR")}개`,
          evidence: "네이버 공개 상품 화면의 누적 리뷰 수",
        },
    detailPage: detailRegistered
      ? {
          verified: true,
          state: "registered",
          label: "상세 콘텐츠 등록",
          evidence: `네이버 상세 콘텐츠 형식 ${text(product.detailContents.editorType)} 확인`,
        }
      : unavailable("자동 확인 불가", "공개 상품 화면에서 상세 콘텐츠 등록 신호를 확인하지 못했습니다."),
    productNotice: unavailable(
      "자동 확인 불가",
      "상품정보고시 원문은 네이버 공개 화면에서 안정적으로 제공되지 않아 점수에서 제외합니다.",
    ),
    discount: discountConfigured
      ? {
          verified: true,
          state: discountApplied ? "applied" : "none",
          rate: discountRatio,
          amount: discountAmount,
          label: discountApplied ? `할인 적용${discountRatio ? ` ${discountRatio}%` : ""}` : "할인 미적용",
          evidence: "네이버 공개 상품 화면의 판매가·할인 정보",
        }
      : unavailable("자동 확인 불가", "공개 상품 화면에 할인 정책 근거가 제공되지 않았습니다."),
    reviewPoint: reviewPoint.configured
      ? {
          verified: true,
          state: reviewPoint.maxPoint > 0 ? "applied" : "none",
          maxPoint: reviewPoint.maxPoint,
          label: reviewPoint.maxPoint > 0 ? `최대 ${reviewPoint.maxPoint.toLocaleString("ko-KR")}원` : "리뷰 포인트 미적용",
          evidence: "네이버 공개 상품 화면의 텍스트·포토 리뷰 혜택",
        }
      : unavailable("자동 확인 불가", "공개 상품 화면에 리뷰 포인트 정책 근거가 제공되지 않았습니다."),
  };
  const verifiedCount = Object.values(signals).filter((signal) => signal.verified).length;

  return {
    ok: true,
    source: "naver_public_product_page",
    checkedAt: new Date().toISOString(),
    product: {
      productId: String(product.id),
      title: text(product.name || product.dispName),
      category: text(product.category?.wholeCategoryName),
      storeName: text(product.channel?.channelName),
      price: finiteNumber(product.salePrice),
      discountedPrice,
      image: text(product.representativeImageUrl),
    },
    signals,
    coverage: {
      verifiedCount,
      total: Object.keys(signals).length,
    },
  };
}

function cacheGet(key) {
  const hit = auditCache.get(key);
  if (!hit || hit.expiresAt <= Date.now()) {
    auditCache.delete(key);
    return null;
  }
  return hit.payload;
}

function cacheSet(key, payload) {
  if (SEO_AUDIT_CACHE_TTL_MS < 1) return;
  auditCache.set(key, { payload, expiresAt: Date.now() + SEO_AUDIT_CACHE_TTL_MS });
  while (auditCache.size > SEO_AUDIT_CACHE_MAX) {
    auditCache.delete(auditCache.keys().next().value);
  }
}

async function readBoundedText(response) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > SEO_AUDIT_MAX_BYTES) throw new Error("네이버 상품 응답이 허용 크기를 초과했습니다.");
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > SEO_AUDIT_MAX_BYTES) {
    throw new Error("네이버 상품 응답이 허용 크기를 초과했습니다.");
  }
  return body;
}

export async function fetchProductPage(target, fetchImpl = fetch, redirectCount = 0) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEO_AUDIT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(target.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ko-KR,ko;q=0.9",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirectCount >= 2) throw new Error("네이버 상품 URL 이동이 반복되어 자동 점검을 중단했습니다.");
      const location = response.headers.get("location") || "";
      if (!location) throw new Error("네이버 상품 URL 이동 위치를 확인하지 못했습니다.");
      const redirected = normalizeProductUrl(new URL(location, target.url).toString());
      if (redirected.productId !== target.productId) throw new Error("상품 URL 이동 결과가 입력값과 일치하지 않습니다.");
      return fetchProductPage(redirected, fetchImpl, redirectCount + 1);
    }
    if (response.status === 429) throw new Error("네이버의 일시적 조회 제한으로 자동 점검하지 못했습니다. 잠시 후 다시 시도해주세요.");
    if (!response.ok) throw new Error("네이버 상품 공개 화면을 불러오지 못했습니다.");
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) throw new Error("네이버 상품 응답 형식을 확인하지 못했습니다.");
    return readBoundedText(response);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("네이버 상품 자동 점검 시간이 초과되었습니다.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request) {
    if (request.method !== "GET") {
      return protectedJson(request, { ok: false, message: "Method not allowed" }, 405);
    }
    const rate = checkRateLimit(request);
    if (!rate.allowed) {
      return protectedJson(request, {
        ok: false,
        message: "자동 SEO 점검 요청이 많습니다. 잠시 후 다시 시도해주세요.",
        retryAfter: rate.retryAfter,
      }, 429);
    }

    let target;
    try {
      target = normalizeProductUrl(new URL(request.url).searchParams.get("targetUrl") || "");
    } catch (error) {
      return protectedJson(request, { ok: false, message: error.message }, 400);
    }

    const cached = cacheGet(target.url);
    if (cached) return protectedJson(request, { ...cached, cached: true });

    try {
      const html = await fetchProductPage(target);
      const payload = parseNaverProductSeoHtml(html, target.productId);
      cacheSet(target.url, payload);
      return protectedJson(request, payload);
    } catch (error) {
      return protectedJson(request, {
        ok: false,
        message: error.message || "네이버 상품 자동 점검에 실패했습니다.",
        source: "naver_public_product_page",
      }, 503);
    }
  },
};

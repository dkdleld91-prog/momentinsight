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
const SEO_AUDIT_PEER_LIMIT = Math.max(2, Math.min(5, Number(process.env.MI_SEO_AUDIT_PEER_LIMIT || 5)));
const SEO_AUDIT_PEER_TIMEOUT_MS = Number(process.env.MI_SEO_AUDIT_PEER_TIMEOUT_MS || 3_500);
const auditCache = new Map();
const auditRateBucket = new Map();

export class ProductAuditSourceError extends Error {
  constructor(message, { status = 424, code = "NAVER_PUBLIC_PAGE_UNAVAILABLE" } = {}) {
    super(message);
    this.name = "ProductAuditSourceError";
    this.status = status;
    this.code = code;
  }
}

function sourceError(message, options) {
  return new ProductAuditSourceError(message, options);
}

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
  if (!match) {
    throw sourceError(
      "네이버 공개 상품 화면에서 자동 확인 정보를 찾지 못했습니다. 상품명·카테고리는 공식 조회 결과로 계속 확인합니다.",
      { code: "NAVER_PUBLIC_PAGE_STATE_MISSING" },
    );
  }
  try {
    return JSON.parse(jsonSafeJavascriptLiteral(match[1]));
  } catch {
    throw sourceError(
      "네이버 공개 상품 화면 형식이 변경되어 일부 항목을 자동 확인하지 못했습니다.",
      { code: "NAVER_PUBLIC_PAGE_FORMAT_CHANGED" },
    );
  }
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

function uniqueStrings(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      if (typeof value === "string") return text(value).replace(/^#/, "");
      if (!value || typeof value !== "object") return "";
      return text(value.text || value.name || value.tag || value.tagName || value.value).replace(/^#/, "");
    })
    .filter((value) => {
      const key = value.replace(/\s+/g, "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function collectLeafText(value, output = [], depth = 0) {
  if (depth > 8 || output.length > 300) return output;
  if (typeof value === "string") {
    const cleaned = text(value);
    if (cleaned) output.push(cleaned);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectLeafText(item, output, depth + 1));
    return output;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectLeafText(item, output, depth + 1));
  }
  return output;
}

function findObjectByKey(value, pattern, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return null;
  for (const [key, child] of Object.entries(value)) {
    if (pattern.test(key)) return child;
  }
  for (const child of Object.values(value)) {
    const match = findObjectByKey(child, pattern, depth + 1);
    if (match) return match;
  }
  return null;
}

export function parseNaverProductDetailJson(detail) {
  const root = detail?.data && typeof detail.data === "object" ? detail.data : detail;
  const signals = {};
  const tags = uniqueStrings(
    root?.seoInfo?.sellerTags ||
    findObjectByKey(root, /^(sellerTags|searchTags|tags)$/i) ||
    [],
  );
  if (tags.length) {
    signals.sellerTags = {
      verified: true,
      values: tags,
      count: tags.length,
      label: `${tags.length}개`,
      evidence: "네이버 공개 상품의 관련 태그",
    };
  }

  const notice = findObjectByKey(root, /productInfoProvidedNotice/i);
  if (notice && (typeof notice === "object" || typeof notice === "string")) {
    const noticeTexts = collectLeafText(notice);
    if (noticeTexts.length) {
      const hasDetailReference = noticeTexts.some((value) => /상세\s*페이지|상품\s*상세|상세\s*참조/i.test(value));
      signals.productNotice = {
        verified: true,
        hasDetailReference,
        fieldCount: noticeTexts.length,
        label: hasDetailReference ? "상세페이지 참조 있음" : "항목별 작성",
        evidence: "네이버 공개 상품정보제공고시",
      };
    }
  }
  return signals;
}

export function parseNaverProductSeoHtml(html, expectedProductId = "") {
  const state = extractPreloadedState(html);
  const product = state?.simpleProductForDetailPage?.A;
  if (!product || !product.id) {
    throw sourceError(
      "네이버 공개 상품 화면에서 상품 정보를 확인하지 못했습니다.",
      { code: "NAVER_PUBLIC_PRODUCT_MISSING" },
    );
  }
  if (expectedProductId && String(product.id) !== String(expectedProductId)) {
    throw sourceError(
      "입력한 URL과 공개 상품 정보가 일치하지 않습니다.",
      { code: "NAVER_PUBLIC_PRODUCT_MISMATCH" },
    );
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
  const signals = {};
  if (reviewCount !== null) {
    signals.review = {
      verified: true,
      value: reviewCount,
      label: `${reviewCount.toLocaleString("ko-KR")}개`,
      evidence: "네이버 공개 상품 화면의 누적 리뷰 수",
    };
  }
  if (discountConfigured) {
    signals.discount = {
      verified: true,
      state: discountApplied ? "applied" : "none",
      rate: discountRatio,
      amount: discountAmount,
      label: discountApplied ? `할인 적용${discountRatio ? ` ${discountRatio}%` : ""}` : "할인 미적용",
      evidence: "네이버 공개 상품 화면의 판매가·할인 정보",
    };
  }
  if (reviewPoint.configured) {
    signals.reviewPoint = {
      verified: true,
      state: reviewPoint.maxPoint > 0 ? "applied" : "none",
      maxPoint: reviewPoint.maxPoint,
      label: reviewPoint.maxPoint > 0 ? `최대 ${reviewPoint.maxPoint.toLocaleString("ko-KR")}원` : "리뷰 포인트 미적용",
      evidence: "네이버 공개 상품 화면의 텍스트·포토 리뷰 혜택",
    };
  }
  Object.assign(signals, parseNaverProductDetailJson(product));

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
      channelUid: text(product.channel?.channelUid),
      channelProductNo: text(product.productNo),
    },
    signals,
    coverage: {
      verifiedCount: Object.keys(signals).length,
      total: 5,
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
  if (length > SEO_AUDIT_MAX_BYTES) {
    throw sourceError(
      "네이버 공개 상품 응답이 커서 자동 확인 범위를 제한했습니다.",
      { code: "NAVER_PUBLIC_PAGE_TOO_LARGE" },
    );
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > SEO_AUDIT_MAX_BYTES) {
    throw sourceError(
      "네이버 공개 상품 응답이 커서 자동 확인 범위를 제한했습니다.",
      { code: "NAVER_PUBLIC_PAGE_TOO_LARGE" },
    );
  }
  return body;
}

async function readBoundedJson(response) {
  const body = await readBoundedText(response);
  try {
    return JSON.parse(body);
  } catch {
    throw sourceError(
      "네이버 공개 상품 상세 응답 형식이 변경되어 일부 항목을 자동 확인하지 못했습니다.",
      { code: "NAVER_PUBLIC_DETAIL_FORMAT_CHANGED" },
    );
  }
}

export async function fetchProductPage(target, fetchImpl = fetch, redirectCount = 0, timeoutMs = SEO_AUDIT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
      if (redirectCount >= 2) {
        throw sourceError(
          "네이버 상품 URL 이동이 반복되어 자동 확인을 중단했습니다.",
          { code: "NAVER_PUBLIC_PAGE_REDIRECT_LOOP" },
        );
      }
      const location = response.headers.get("location") || "";
      if (!location) {
        throw sourceError(
          "네이버 상품 URL 이동 위치를 확인하지 못했습니다.",
          { code: "NAVER_PUBLIC_PAGE_REDIRECT_MISSING" },
        );
      }
      const redirected = normalizeProductUrl(new URL(location, target.url).toString());
      if (redirected.productId !== target.productId) {
        throw sourceError(
          "상품 URL 이동 결과가 입력값과 일치하지 않습니다.",
          { code: "NAVER_PUBLIC_PRODUCT_MISMATCH" },
        );
      }
      return fetchProductPage(redirected, fetchImpl, redirectCount + 1, timeoutMs);
    }
    if (response.status === 429) {
      throw sourceError(
        "네이버의 일시적 조회 제한으로 리뷰·할인 정보를 자동 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
        { status: 429, code: "NAVER_PUBLIC_PAGE_RATE_LIMITED" },
      );
    }
    if (!response.ok) {
      throw sourceError(
        "네이버 공개 상품 화면을 불러오지 못해 일부 항목을 자동 확인하지 못했습니다.",
        { code: "NAVER_PUBLIC_PAGE_HTTP_ERROR" },
      );
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      throw sourceError(
        "네이버 공개 상품 응답 형식을 확인하지 못했습니다.",
        { code: "NAVER_PUBLIC_PAGE_CONTENT_TYPE" },
      );
    }
    return readBoundedText(response);
  } catch (error) {
    if (error instanceof ProductAuditSourceError) throw error;
    if (error?.name === "AbortError") {
      throw sourceError(
        "네이버 공개 상품 확인 시간이 초과되어 일부 항목을 자동 확인하지 못했습니다.",
        { code: "NAVER_PUBLIC_PAGE_TIMEOUT" },
      );
    }
    throw sourceError(
      "네이버 공개 상품 화면 연결이 일시적으로 불안정해 일부 항목을 자동 확인하지 못했습니다.",
      { code: "NAVER_PUBLIC_PAGE_NETWORK_ERROR" },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchProductDetail(target, product, fetchImpl = fetch, timeoutMs = SEO_AUDIT_PEER_TIMEOUT_MS) {
  const channelUid = text(product?.channelUid);
  const channelProductNo = text(product?.channelProductNo);
  if (!channelUid || !/^\d+$/.test(channelProductNo)) return null;
  const detailUrl = `https://${target.host}/i/v2/channels/${encodeURIComponent(channelUid)}/products/${channelProductNo}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(detailUrl, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "accept-language": "ko-KR,ko;q=0.9",
        referer: target.url,
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1",
      },
    });
    if (response.status === 429) {
      throw sourceError(
        "네이버의 일시적 조회 제한으로 상품정보제공고시를 자동 확인하지 못했습니다.",
        { status: 429, code: "NAVER_PUBLIC_DETAIL_RATE_LIMITED" },
      );
    }
    if (!response.ok) {
      throw sourceError(
        "네이버 공개 상품 상세 정보를 불러오지 못했습니다.",
        { code: "NAVER_PUBLIC_DETAIL_HTTP_ERROR" },
      );
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw sourceError(
        "네이버 공개 상품 상세 응답 형식을 확인하지 못했습니다.",
        { code: "NAVER_PUBLIC_DETAIL_CONTENT_TYPE" },
      );
    }
    return readBoundedJson(response);
  } catch (error) {
    if (error instanceof ProductAuditSourceError) throw error;
    if (error?.name === "AbortError") {
      throw sourceError(
        "네이버 상품정보제공고시 확인 시간이 초과됐습니다.",
        { code: "NAVER_PUBLIC_DETAIL_TIMEOUT" },
      );
    }
    throw sourceError(
      "네이버 공개 상품 상세 연결이 일시적으로 불안정합니다.",
      { code: "NAVER_PUBLIC_DETAIL_NETWORK_ERROR" },
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function auditProduct(target, {
  fetchImpl = fetch,
  timeoutMs = SEO_AUDIT_TIMEOUT_MS,
  includeDetail = true,
} = {}) {
  const cacheKey = `${target.url}|${includeDetail ? "detail" : "summary"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };
  const html = await fetchProductPage(target, fetchImpl, 0, timeoutMs);
  const payload = parseNaverProductSeoHtml(html, target.productId);
  if (includeDetail) {
    try {
      const detail = await fetchProductDetail(target, payload.product, fetchImpl, SEO_AUDIT_PEER_TIMEOUT_MS);
      if (detail) Object.assign(payload.signals, parseNaverProductDetailJson(detail));
    } catch {
      // 상세 API 제한이 있어도 공개 HTML에서 확정한 항목은 그대로 제공합니다.
    }
  }
  payload.coverage.verifiedCount = Object.keys(payload.signals).length;
  cacheSet(cacheKey, payload);
  return payload;
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function buildReviewBenchmark(targetPayload, peerPayloads) {
  const targetReviewCount = finiteNumber(targetPayload?.signals?.review?.value);
  const peerReviewCounts = (Array.isArray(peerPayloads) ? peerPayloads : [])
    .map((payload) => finiteNumber(payload?.signals?.review?.value))
    .filter((value) => value !== null)
    .slice(0, SEO_AUDIT_PEER_LIMIT);
  if (targetReviewCount === null || peerReviewCounts.length < 2) return null;

  const peerMedian = median(peerReviewCounts);
  const peerAverage = Math.round(
    peerReviewCounts.reduce((sum, value) => sum + value, 0) / peerReviewCounts.length,
  );
  const ratio = peerAverage > 0 ? targetReviewCount / peerAverage : (targetReviewCount > 0 ? 1 : 0);
  const label = ratio >= 1 ? "상위권 수준" : ratio >= 0.6 ? "근접" : ratio >= 0.3 ? "보완" : "매우 부족";
  return {
    verified: true,
    source: "naver_public_peer_products",
    sampleSize: peerReviewCounts.length,
    targetReviewCount,
    peerReviewCounts,
    median: peerMedian,
    average: peerAverage,
    ratio: Number(ratio.toFixed(3)),
    label,
    evidence: `상위 오가닉 상품 공개 화면 ${peerReviewCounts.length}개 표본`,
  };
}

function peerTargetsFromRequest(request, target) {
  const seen = new Set([target.url]);
  const peers = [];
  for (const value of new URL(request.url).searchParams.getAll("peerUrl")) {
    if (peers.length >= SEO_AUDIT_PEER_LIMIT) break;
    try {
      const peer = normalizeProductUrl(value);
      if (seen.has(peer.url)) continue;
      seen.add(peer.url);
      peers.push(peer);
    } catch {
      // 공식 쇼핑 결과 중 직접 확인 가능한 네이버 상품 URL만 표본으로 사용합니다.
    }
  }
  return peers;
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

    try {
      const payload = await auditProduct(target);
      const peerTargets = peerTargetsFromRequest(request, target);
      if (!peerTargets.length) return protectedJson(request, payload);

      const peerResults = await Promise.allSettled(
        peerTargets.map((peer) => auditProduct(peer, {
          timeoutMs: SEO_AUDIT_PEER_TIMEOUT_MS,
          includeDetail: false,
        })),
      );
      const peerPayloads = peerResults
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      const reviewBenchmark = buildReviewBenchmark(payload, peerPayloads);
      return protectedJson(request, reviewBenchmark ? { ...payload, reviewBenchmark } : payload);
    } catch (error) {
      return protectedJson(request, {
        ok: false,
        message: error.message || "네이버 상품 자동 점검에 실패했습니다.",
        code: error instanceof ProductAuditSourceError ? error.code : "NAVER_PRODUCT_SEO_AUDIT_FAILED",
        source: "naver_public_product_page",
      }, error instanceof ProductAuditSourceError ? error.status : 503);
    }
  },
};

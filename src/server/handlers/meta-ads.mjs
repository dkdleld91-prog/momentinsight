import { isLocalRequest, protectedJson } from "../security.mjs";

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
const META_ADS_ARCHIVE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}/ads_archive`;
const META_ADS_FIELDS = [
  "id",
  "page_id",
  "page_name",
  "ad_snapshot_url",
  "ad_creative_bodies",
  "ad_creative_link_captions",
  "ad_creative_link_titles",
  "ad_creative_link_descriptions",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "publisher_platforms",
].join(",");
const META_ADS_RATE_WINDOW_MS = Number(process.env.MI_META_ADS_RATE_WINDOW_MS || 60_000);
const META_ADS_RATE_LIMIT = Number(process.env.MI_META_ADS_RATE_LIMIT || 20);
const metaAdsRateBucket = new Map();
const META_COMMERCE_CONTEXT_TERMS = [
  "가격",
  "구매",
  "구매하기",
  "특가",
  "할인",
  "배송",
  "무료배송",
  "주문",
  "판매",
  "쇼핑",
  "스토어",
  "공식몰",
  "제품",
  "상품",
  "리뷰",
  "추천",
  "런칭",
  "브랜드",
  "공구",
  "shop",
  "store",
];
const META_LOW_INTENT_CONTEXT_TERMS = [
  "소설",
  "웹소설",
  "드라마",
  "회차",
  "다음화",
  "읽어",
  "읽기",
  "읽으려면",
  "계속 읽",
  "무료로 계속",
  "연재",
  "웹툰",
  "책",
  "binge books",
  "novel",
  "story",
  "episode",
  "아파트",
  "분양",
  "민간임대",
  "계약금",
  "입주",
  "병원",
  "의원",
  "시술",
];

function config(env = {}) {
  return {
    accessToken: env.META_AD_LIBRARY_ACCESS_TOKEN
      || env.META_ADS_LIBRARY_ACCESS_TOKEN
      || process.env.META_AD_LIBRARY_ACCESS_TOKEN
      || process.env.META_ADS_LIBRARY_ACCESS_TOKEN
      || "",
  };
}

function json(request, body, status = 200) {
  return protectedJson(request, body, status);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCountry(value) {
  const next = normalizeText(value || "KR").toUpperCase();
  return /^[A-Z]{2}$/.test(next) ? next : "KR";
}

function normalizePlatform(value) {
  const next = normalizeText(value).toUpperCase();
  const allowed = new Set(["FACEBOOK", "INSTAGRAM", "MESSENGER", "AUDIENCE_NETWORK"]);
  return allowed.has(next) ? next : "";
}

function normalizeMediaType(value) {
  const next = normalizeText(value).toUpperCase();
  const allowed = new Set(["ALL", "IMAGE", "VIDEO", "MEME", "NONE"]);
  return allowed.has(next) ? next : "ALL";
}

function normalizeStatus(value) {
  const next = normalizeText(value || "ALL").toUpperCase();
  const allowed = new Set(["ACTIVE", "INACTIVE", "ALL"]);
  return allowed.has(next) ? next : "ALL";
}

function normalizeLimit(value) {
  const number = Number(value || 12);
  if (!Number.isFinite(number)) return 12;
  return Math.max(1, Math.min(25, Math.floor(number)));
}

function normalizeApiLimit(value) {
  return Math.min(100, Math.max(25, normalizeLimit(value) * 6));
}

function parsePageIds(value) {
  return normalizeText(value)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[0-9]{3,}$/.test(item))
    .slice(0, 10);
}

function clientRateKey(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim() || request.headers.get("x-real-ip") || "anonymous";
}

function checkRateLimit(request) {
  if (isLocalRequest(request)) return { allowed: true };
  const now = Date.now();
  const key = clientRateKey(request);
  const fresh = (metaAdsRateBucket.get(key) || []).filter((time) => now - time < META_ADS_RATE_WINDOW_MS);

  if (fresh.length >= META_ADS_RATE_LIMIT) {
    metaAdsRateBucket.set(key, fresh);
    const retryAfter = Math.max(1, Math.ceil((META_ADS_RATE_WINDOW_MS - (now - fresh[0])) / 1000));
    return { allowed: false, retryAfter };
  }

  fresh.push(now);
  metaAdsRateBucket.set(key, fresh);

  if (metaAdsRateBucket.size > 1000) {
    for (const [bucketKey, times] of metaAdsRateBucket.entries()) {
      const activeTimes = times.filter((time) => now - time < META_ADS_RATE_WINDOW_MS);
      if (activeTimes.length) metaAdsRateBucket.set(bucketKey, activeTimes);
      else metaAdsRateBucket.delete(bucketKey);
    }
  }

  return { allowed: true };
}

function firstText(values) {
  if (Array.isArray(values)) return normalizeText(values[0] || "");
  return normalizeText(values);
}

function safeSnapshotUrl(value) {
  const raw = normalizeText(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.searchParams.delete("access_token");
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeSearchText(value) {
  return stripMetaText(value)
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMetaText(value) {
  return normalizeText(String(value || "").replace(/<[^>]*>/g, " "));
}

function searchTokens(value) {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const compact = normalized.replace(/\s+/g, "");
  return [...new Set([
    normalized,
    compact,
    ...normalized.split(" ").filter((token) => token.length >= 2),
  ].filter(Boolean))];
}

function metaFallbackTerms(value) {
  const original = normalizeText(value);
  if (!original) return [""];
  const compact = normalizeSearchText(original).replace(/\s+/g, "");
  const terms = [original];

  if (compact.includes("냉풍기") || compact.includes("냉방기")) {
    terms.push("냉풍기", "냉방기");
  }

  if (compact.includes("써큘레이터") || compact.includes("서큘레이터")) {
    terms.push("써큘레이터", "서큘레이터");
  }

  return [...new Set(terms.map(normalizeText).filter(Boolean))].slice(0, 5);
}

function normalizeAd(item) {
  const rawSnapshotUrl = normalizeText(item.ad_snapshot_url);
  return {
    id: normalizeText(item.id),
    libraryId: normalizeText(item.id),
    pageId: normalizeText(item.page_id),
    pageName: normalizeText(item.page_name),
    snapshotUrl: safeSnapshotUrl(rawSnapshotUrl),
    snapshotAvailable: Boolean(rawSnapshotUrl),
    body: firstText(item.ad_creative_bodies),
    caption: firstText(item.ad_creative_link_captions),
    title: firstText(item.ad_creative_link_titles),
    description: firstText(item.ad_creative_link_descriptions),
    deliveryStartTime: normalizeText(item.ad_delivery_start_time),
    deliveryStopTime: normalizeText(item.ad_delivery_stop_time),
    publisherPlatforms: Array.isArray(item.publisher_platforms) ? item.publisher_platforms.map(normalizeText).filter(Boolean) : [],
  };
}

function normalizePaging(paging) {
  if (!paging || typeof paging !== "object") return null;
  const cursors = paging.cursors && typeof paging.cursors === "object"
    ? {
      before: normalizeText(paging.cursors.before),
      after: normalizeText(paging.cursors.after),
    }
    : null;
  return {
    cursors,
    hasNext: Boolean(paging.next),
  };
}

function adSearchText(ad) {
  return normalizeSearchText([
    ad.pageName,
    ad.body,
    ad.caption,
    ad.title,
    ad.description,
  ].join(" "));
}

function tokenMatchesText(text, token) {
  const normalizedText = normalizeSearchText(text);
  const compactText = normalizedText.replace(/\s+/g, "");
  const normalizedToken = normalizeSearchText(token);
  const compactToken = normalizedToken.replace(/\s+/g, "");
  return Boolean(normalizedToken)
    && (normalizedText.includes(normalizedToken) || compactText.includes(compactToken));
}

function countContextHits(text, terms) {
  return terms.reduce((count, term) => count + (tokenMatchesText(text, term) ? 1 : 0), 0);
}

function metaAdRelevanceScore(ad, terms) {
  const tokens = searchTokens(terms);
  if (!tokens.length) return 1;

  const text = adSearchText(ad);
  const strongText = [
    ad.pageName,
    ad.caption,
    ad.title,
    ad.description,
  ].join(" ");
  const bodyText = ad.body;
  const hasTerm = tokens.some((token) => tokenMatchesText(text, token));
  if (!hasTerm) return 0;

  const hasStrongTerm = tokens.some((token) => tokenMatchesText(strongText, token));
  const hasBodyTerm = tokens.some((token) => tokenMatchesText(bodyText, token));
  const commerceHits = countContextHits(text, META_COMMERCE_CONTEXT_TERMS);
  const lowIntentHits = countContextHits(text, META_LOW_INTENT_CONTEXT_TERMS);

  if (lowIntentHits > 0 && commerceHits === 0 && !hasStrongTerm) return 0;

  let score = 1;
  if (hasStrongTerm) score += 4;
  if (hasBodyTerm) score += 1;
  score += Math.min(commerceHits, 4);
  score -= Math.min(lowIntentHits * 2, 8);
  if (!hasStrongTerm && commerceHits === 0) score -= 2;

  return score;
}

function isRelevantAd(ad, terms) {
  return metaAdRelevanceScore(ad, terms) >= 2;
}

function safeMetaError(payload) {
  const error = payload && payload.error ? payload.error : null;
  if (!error) return "";
  return normalizeText(error.message || error.error_user_msg || error.type || "");
}

function metaErrorResponse(payload) {
  const detail = safeMetaError(payload);
  if (/permission|OAuthException/i.test(detail)) {
    return {
      code: "META_AD_LIBRARY_PERMISSION_DENIED",
      message: "Meta 토큰 권한이 부족합니다. 앱 토큰이 아닌 사용자 액세스 토큰으로 발급하고 ads_read 권한을 포함해야 합니다.",
      detail: process.env.NODE_ENV === "development" ? detail : undefined,
    };
  }

  if (/active access token|invalid|expired/i.test(detail)) {
    return {
      code: "META_AD_LIBRARY_AUTH_INVALID",
      message: "Meta 액세스 권한이 유효하지 않거나 만료되었습니다. Graph API Explorer에서 사용자 토큰을 다시 발급해주세요.",
      detail: process.env.NODE_ENV === "development" ? detail : undefined,
    };
  }

  return {
    code: "META_AD_LIBRARY_LOOKUP_FAILED",
    message: "Meta 광고 라이브러리 조회에 실패했습니다.",
    detail: process.env.NODE_ENV === "development" ? detail : undefined,
  };
}

async function fetchMetaAdsPage(env, query, searchTerms) {
  const params = new URLSearchParams({
    access_token: env.accessToken,
    fields: META_ADS_FIELDS,
    ad_type: "ALL",
    ad_active_status: query.status,
    ad_reached_countries: JSON.stringify([query.country]),
    media_type: query.mediaType,
    limit: String(query.apiLimit || query.limit),
  });

  if (searchTerms) params.set("search_terms", searchTerms);
  if (searchTerms) params.set("search_type", "KEYWORD_UNORDERED");
  if (query.pageIds.length) params.set("search_page_ids", query.pageIds.join(","));
  if (query.platform) params.set("publisher_platforms", JSON.stringify([query.platform]));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.MI_META_ADS_TIMEOUT_MS || 12000));

  try {
    const response = await fetch(`${META_ADS_ARCHIVE_URL}?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const metaError = metaErrorResponse(payload);
      return {
        ok: false,
        status: response.status,
        ...metaError,
      };
    }

    const ads = Array.isArray(payload?.data) ? payload.data.map(normalizeAd) : [];

    return {
      ok: true,
      ads,
      rawCount: ads.length,
      filteredCount: 0,
      paging: normalizePaging(payload?.paging),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMetaAds(env, query) {
  const terms = query.searchTerms ? metaFallbackTerms(query.searchTerms) : [""];
  const pages = [];
  const usedTerms = [];
  const uniqueAds = new Map();
  let rawCount = 0;
  let filteredCount = 0;
  let paging = null;

  for (const term of terms) {
    const page = await fetchMetaAdsPage(env, query, term);
    if (!page.ok) return page;

    usedTerms.push(term);
    rawCount += page.rawCount || 0;
    filteredCount += page.filteredCount || 0;
    if (!paging && page.paging) paging = page.paging;

    const pageAds = page.ads || [];
    const relevantAds = term
      ? pageAds
        .map((ad) => ({ ad, score: metaAdRelevanceScore(ad, term) }))
        .filter((item) => item.score >= 2)
        .sort((left, right) => right.score - left.score)
        .map((item) => ({ ...item.ad, relevanceScore: item.score }))
      : pageAds;
    filteredCount += Math.max(0, pageAds.length - relevantAds.length);

    for (const ad of relevantAds) {
      if (!ad.id || uniqueAds.has(ad.id)) continue;
      uniqueAds.set(ad.id, { ...ad, matchedQuery: term });
    }

    pages.push(page);
    if (uniqueAds.size >= query.limit) break;
    if (uniqueAds.size > 0 && term === terms[0] && terms.length === 1) break;
  }

  return {
    ok: true,
    ads: [...uniqueAds.values()].slice(0, query.limit),
    rawCount,
    filteredCount,
    searchedTerms: usedTerms,
    paging,
    pageCount: pages.length,
  };
}

export default {
  async fetch(request, runtimeEnv = {}) {
    if (request.method !== "GET") {
      return json(request, { ok: false, message: "Method not allowed" }, 405);
    }

    const limited = checkRateLimit(request);
    if (!limited.allowed) {
      return json(request, {
        ok: false,
        code: "META_ADS_RATE_LIMITED",
        message: `조회가 많습니다. ${limited.retryAfter}초 후 다시 시도해주세요.`,
      }, 429);
    }

    const url = new URL(request.url);
    const searchTerms = normalizeText(url.searchParams.get("query") || url.searchParams.get("searchTerms"));
    const pageIds = parsePageIds(url.searchParams.get("pageIds"));
    const query = {
      searchTerms,
      pageIds,
      country: normalizeCountry(url.searchParams.get("country")),
      platform: normalizePlatform(url.searchParams.get("platform")),
      mediaType: normalizeMediaType(url.searchParams.get("mediaType")),
      status: normalizeStatus(url.searchParams.get("status")),
      limit: normalizeLimit(url.searchParams.get("limit")),
      apiLimit: normalizeApiLimit(url.searchParams.get("limit")),
    };

    if (!query.searchTerms && !query.pageIds.length) {
      return json(request, {
        ok: false,
        code: "META_ADS_QUERY_REQUIRED",
        message: "브랜드명, 제품명, 경쟁사명 또는 Meta 페이지 ID를 입력해주세요.",
      }, 400);
    }

    if (query.searchTerms && query.searchTerms.length < 2) {
      return json(request, {
        ok: false,
        code: "META_ADS_QUERY_TOO_SHORT",
        message: "검색어는 2글자 이상 입력해주세요.",
      }, 400);
    }

    const env = config(runtimeEnv);
    if (!env.accessToken) {
      return json(request, {
        ok: false,
        code: "META_AD_LIBRARY_NOT_CONFIGURED",
        message: "Meta 광고 라이브러리 API 키가 연결되지 않았습니다. Vercel 환경변수 META_AD_LIBRARY_ACCESS_TOKEN을 설정하면 실제 광고를 조회합니다.",
      }, 503);
    }

    try {
      const result = await fetchMetaAds(env, query);
      if (!result.ok) return json(request, result, result.status >= 400 ? 502 : 500);

      return json(request, {
        ok: true,
        source: "meta_ad_library",
        checkedAt: new Date().toISOString(),
        query,
        count: result.ads.length,
        rawCount: result.rawCount || result.ads.length,
        filteredCount: result.filteredCount || 0,
        searchedTerms: result.searchedTerms || [query.searchTerms].filter(Boolean),
        ads: result.ads,
        paging: result.paging,
      });
    } catch (error) {
      return json(request, {
        ok: false,
        code: "META_AD_LIBRARY_LOOKUP_FAILED",
        message: "Meta 광고 라이브러리 서버 연결을 확인해주세요.",
        detail: process.env.NODE_ENV === "development" ? error?.message : undefined,
      }, 502);
    }
  },
};

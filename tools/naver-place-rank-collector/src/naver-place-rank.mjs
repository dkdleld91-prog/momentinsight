const DEFAULT_MAX_RANK = 300;
const DEFAULT_TIMEOUT_MS = Number(process.env.NAVER_PLACE_PROVIDER_TIMEOUT_MS || 90000);
const DEFAULT_MAX_SCROLLS = Math.max(1, Number(process.env.NAVER_PLACE_PROVIDER_MAX_SCROLLS || 90));
const OVERALL_TIMEOUT_MS = Math.max(
  20000,
  Math.min(Number(process.env.NAVER_PLACE_PROVIDER_OVERALL_TIMEOUT_MS || 75000), 80000)
);
const HEADLESS = String(process.env.NAVER_PLACE_PROVIDER_HEADLESS || "true") !== "false";
const DEEP_SCAN = String(process.env.NAVER_PLACE_PROVIDER_DEEP_SCAN || "false") === "true";
const APIFY_IDENTITY_ACTOR_ID = String(
  process.env.APIFY_NAVER_MAPS_IDENTITY_ACTOR_ID ||
  process.env.APIFY_NAVER_MAPS_ACTOR_ID || "abotapi~naver-map-scraper"
).trim();
const APIFY_SEARCH_ACTOR_ID = String(
  process.env.APIFY_NAVER_MAPS_SEARCH_ACTOR_ID || "oxygenated_quagmire~naver-place-search"
).trim();
const APIFY_DEEP_SEARCH_ACTOR_ID = String(
  process.env.APIFY_NAVER_MAPS_DEEP_SEARCH_ACTOR_ID || "delicious_zebu~naver-map-search-results-scraper"
).trim();
const APIFY_FALLBACK_ACTOR_ID = String(
  process.env.APIFY_NAVER_MAPS_FALLBACK_ACTOR_ID || "abotapi~naver-map-scraper"
).trim();

const NAVER_MAP_SEARCH_BASE = "https://map.naver.com/p/search/";
const NAVER_PLACE_LIST_BASE = "https://pcmap.place.naver.com/place/list";
const NAVER_PLACE_MAX_RESULTS = 300;
// Leave enough time to serialize a truthful partial result and close Chromium
// even when the hosted browser is briefly CPU-starved.
const COLLECTION_DEADLINE_GUARD_MS = 12000;
const GROWTH_POLL_INTERVAL_MS = 220;
const GROWTH_POLL_ATTEMPTS = 6;
const EXHAUSTED_STABLE_ROUNDS = 3;
const LIST_SELECTOR_TIMEOUT_MS = Math.max(1000, Math.min(DEFAULT_TIMEOUT_MS, 8000));
const IDENTITY_OPTIONAL_SELECTOR_TIMEOUT_MS = 1000;
const RESULT_CACHE_TTL_MS = Math.max(
  60000,
  Math.min(30 * 60 * 1000, Number(process.env.NAVER_PLACE_RESULT_CACHE_TTL_MS || 10 * 60 * 1000))
);
const RESULT_CACHE_MAX = Math.max(5, Math.min(100, Number(process.env.NAVER_PLACE_RESULT_CACHE_MAX || 40)));
const resultCache = new Map();
const LIST_FRAME_PATTERN = /pcmap\.place\.naver\.com\/(?:restaurant|place|hospital|accommodation|hairshop|beauty|attraction|shopping|list)/i;
const DETAIL_FRAME_PATTERN = /pcmap\.place\.naver\.com\/(?:restaurant|place|hospital|accommodation|hairshop|beauty|attraction|shopping)\/(\d+)/i;
const AD_HINT_PATTERN = /광고|스폰서|파워링크/i;
const CHIP_WORDS = [
  "예약",
  "톡톡",
  "쿠폰",
  "주차",
  "포장",
  "배달",
  "방문접수",
  "무선 인터넷",
  "남/녀 화장실 구분",
  "네이버페이",
  "영업 중",
  "영업 종료",
  "휴무",
  "브레이크타임",
];

function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeComparable(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()[\]{}'"`‘’“”·|:,._\-~!@#$%^&*+=?/\\]/g, "");
}

function clampMaxRank() {
  return DEFAULT_MAX_RANK;
}

function extractPlaceId(value) {
  return extractPlaceIds(value)[0] || "";
}

function extractPlaceIds(value) {
  const text = normalizeText(value);
  if (!text) return [];
  const ids = new Set();
  const direct = text.match(/^\d{5,}$/);
  if (direct) ids.add(direct[0]);

  const decoded = decodeURIComponentSafe(text);
  const patterns = [
    /\/entry\/place\/(\d+)/gi,
    /\/place\/(\d+)/gi,
    /\/(?:restaurant|hospital|accommodation|hairshop|beauty|attraction|shopping)\/(\d+)/gi,
    /[?&]placeId=(\d+)/gi,
    /[?&]id=(\d+)/gi,
    /place%2F(\d+)/gi,
    /entry%2Fplace%2F(\d+)/gi,
    /(?:placeId|place_id|businessId|business_id)["'=:\s]+(\d{5,})/gi,
  ];

  for (const source of [text, decoded]) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        if (match[1]) ids.add(match[1]);
      }
    }
  }
  return Array.from(ids);
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function normalizeUrl(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(naver\.me|map\.naver\.com|m\.place\.naver\.com|place\.naver\.com|pcmap\.place\.naver\.com)\//i.test(text)) {
    return "https://" + text;
  }
  return text;
}

function cleanPlaceTitle(value) {
  return normalizeText(value)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s*[:|-]\s*네이버\s*(지도|플레이스)?\s*$/i, "")
    .replace(/\s*-\s*NAVER\s*(Map|Place)?\s*$/i, "")
    .replace(/\s*네이버\s*지도\s*$/i, "")
    .replace(/\s*네이버\s*플레이스\s*$/i, "")
    .trim();
}

function cleanRowName(value) {
  let text = normalizeText(value);
  if (!text) return "";
  text = text.replace(/\s+/g, " ");
  for (const word of CHIP_WORDS) {
    const index = text.indexOf(word);
    if (index > 1) text = text.slice(0, index).trim();
  }
  return text
    .replace(/^\d+\s*/, "")
    .replace(/\s*광고\s*$/i, "")
    .trim();
}

function isLikelyPlaceName(value) {
  const text = normalizeText(value);
  if (text.length < 2 || text.length > 80) return false;
  if (/^\d+$/.test(text)) return false;
  if (/^(장소|네이버지도|네이버 지도|네이버 플레이스|NAVER Map|NAVER Place)$/i.test(text)) return false;
  if (/^(예약|톡톡|쿠폰|방문자리뷰|블로그리뷰|저장|거리뷰|길찾기|공유|주문|메뉴|사진|리뷰)$/i.test(text)) return false;
  return true;
}

function candidateMatchesTarget(candidate, target) {
  const targetIds = collectTargetIds(target);
  const candidateIds = collectCandidateIds(candidate);
  // A persisted place ID is the authority. Never fall through to a fuzzy name
  // match when the candidate identifies a different place (or has no ID).
  if (targetIds.length) return candidateIds.some((id) => targetIds.includes(id));

  const targetName = normalizeComparable(target.placeName);
  const candidateName = normalizeComparable(candidate.name);
  if (!targetName || !candidateName) return false;

  if (targetName.length < 4 || candidateName.length < 4) return false;
  if (candidateName === targetName) return true;

  const shortName = candidateName.length < targetName.length ? candidateName : targetName;
  const longName = candidateName.length < targetName.length ? targetName : candidateName;
  if (shortName.length < 6) return false;

  const overlap = shortName.length / Math.max(longName.length, 1);
  return overlap >= 0.72 && longName.includes(shortName);
}

function collectTargetIds(target = {}) {
  return uniqueValues([
    target.placeId,
    ...(Array.isArray(target.placeIds) ? target.placeIds : []),
    ...extractPlaceIds(target.placeUrl),
    ...extractPlaceIds(target.url),
    ...extractPlaceIds(target.text),
  ]);
}

function collectCandidateIds(candidate = {}) {
  return uniqueValues([
    candidate.id,
    candidate.placeId,
    ...(Array.isArray(candidate.placeIds) ? candidate.placeIds : []),
    ...extractPlaceIds(candidate.url),
    ...extractPlaceIds(candidate.text),
    ...extractPlaceIds(candidate.aria),
    ...extractPlaceIds(candidate.html),
    ...(Array.isArray(candidate.hrefs) ? candidate.hrefs.flatMap((href) => extractPlaceIds(href)) : []),
  ]);
}

function getCandidatePlaceUrl(candidate = {}) {
  return (
    candidate.url ||
    (Array.isArray(candidate.hrefs)
      ? candidate.hrefs.find((href) =>
          /(?:m\.place\.naver\.com|pcmap\.place\.naver\.com|map\.naver\.com|\/(?:entry\/place|place|restaurant|hospital|accommodation|hairshop|beauty|attraction|shopping)\/)/i.test(href)
        )
      : "") ||
    ""
  );
}

function uniqueValues(values) {
  return Array.from(
    new Set(
      values
        .flat()
        .map((value) => normalizeText(value))
        .filter(Boolean)
    )
  );
}

function apifyToken() {
  return String(process.env.APIFY_NAVER_MAPS_TOKEN || process.env.APIFY_TOKEN || "").trim();
}

function buildApifyIdentityInput(actorId, placeUrl) {
  return {
    mode: "url",
    startUrls: [{ url: placeUrl }],
    includeDetails: false,
    includeReviews: false,
    maxItems: 1,
  };
}

function buildApifySearchInput(actorId, keyword, maxRank = DEFAULT_MAX_RANK) {
  const normalizedActorId = normalizeText(actorId).toLowerCase();
  if (normalizedActorId.includes("delicious_zebu~naver-map-search-results-scraper")) {
    return {
      keywords: [keyword],
      urls: [],
      scrapePlaceDetails: false,
      maxResultsPerKeyword: maxRank,
    };
  }
  if (normalizedActorId.includes("solidcode~naver-map-scraper")) {
    return {
      searchTerms: [keyword],
      startUrls: [],
      maxResults: maxRank,
      includeReviews: false,
      includeMenu: false,
    };
  }
  if (normalizedActorId.includes("abotapi~naver-map-scraper")) {
    return {
      mode: "search",
      keywords: [keyword],
      sort: "relevance",
      includeDetails: false,
      includeReviews: false,
      maxItems: maxRank,
    };
  }
  return {
    queries: [keyword],
    maxResults: maxRank,
    includePhotos: false,
    includeReviewSnippets: false,
    proxyConfiguration: { useApifyProxy: true },
  };
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlMetaContent(html, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]);
  }
  return "";
}

async function resolvePlaceIdentityViaHttp(value, fetchImpl = fetch) {
  const originalUrl = normalizeUrl(value);
  const result = {
    url: originalUrl,
    placeId: extractPlaceId(originalUrl),
    placeIds: extractPlaceIds(originalUrl),
    placeName: "",
  };
  if (!/^https?:\/\//i.test(originalUrl) || result.placeId) return result;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetchImpl(originalUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (!response.ok) return result;
    const body = (await response.text()).slice(0, 400000);
    const finalUrl = normalizeText(response.url) || originalUrl;
    const ogUrl = htmlMetaContent(body, "og:url");
    const canonicalMatch = body.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    const canonicalUrl = decodeHtmlEntities(canonicalMatch?.[1] || "");
    const placeIds = uniqueValues([
      ...result.placeIds,
      ...extractPlaceIds(finalUrl),
      ...extractPlaceIds(ogUrl),
      ...extractPlaceIds(canonicalUrl),
      ...extractPlaceIds(body),
    ]);
    return {
      url: [canonicalUrl, ogUrl, finalUrl].find((url) => extractPlaceIds(url).length) || finalUrl,
      placeId: placeIds[0] || "",
      placeIds,
      placeName: cleanPlaceTitle(htmlMetaContent(body, "og:title")),
    };
  } catch {
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function firstText(...values) {
  return values.map(normalizeText).find(Boolean) || "";
}

function firstMetricText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).normalize("NFKC").trim();
    if (text) return text;
  }
  return "";
}

function parseMetricCount(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).normalize("NFKC").trim().replace(/,/g, "");
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function aggregateCandidateMetrics(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const aggregateMetric = (key) => {
    const values = rows.map((candidate) => parseMetricCount(candidate?.[key]));
    const knownValues = values.filter((value) => value !== null);
    const coverage = { knownCount: knownValues.length, totalCount: rows.length };
    return {
      value: coverage.knownCount === coverage.totalCount
        ? knownValues.reduce((sum, value) => sum + value, 0)
        : null,
      coverage,
    };
  };
  const blog = aggregateMetric("blogReviewCount");
  const visit = aggregateMetric("visitorReviewCount");
  return {
    scope: "organic_search_results",
    blogCount: blog.value,
    visitReviewCount: visit.value,
    businessCount: rows.length,
    coverage: {
      blogCount: blog.coverage,
      visitReviewCount: visit.coverage,
    },
  };
}

function positiveRank(...values) {
  for (const value of values) {
    const parsed = Number(String(value ?? "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  return null;
}

function flattenApifyItems(items = []) {
  const flattened = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;

    const nested = [value.results, value.places, value.items]
      .filter(Array.isArray)
      .flat();
    if (Array.isArray(value.data)) nested.push(...value.data);
    if (nested.length) {
      nested.forEach(visit);
      return;
    }
    if (value.data && typeof value.data === "object" && !Array.isArray(value.data)) {
      const dataHasResults = [value.data.results, value.data.places, value.data.items].some(Array.isArray);
      if (dataHasResults) {
        visit(value.data);
        return;
      }
    }
    flattened.push(value);
  };
  visit(items);
  return flattened;
}

function apifyCandidate(item = {}, index = 0) {
  const nestedPlace = [item.place, item.business]
    .find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
  const source = { ...item, ...nestedPlace };
  const url = firstText(
    source.url,
    source.placeUrl,
    source.place_url,
    source.placeLink,
    source.link,
    source.webUrl,
    source.web_url,
    source.naverUrl,
    source.naver_url,
    source.NaverMapUrl,
    source.NaverUrl,
    source.URL
  );
  const id = firstText(
    source.placeId,
    source.place_id,
    source.businessId,
    source.business_id,
    source.cid,
    extractPlaceId(url),
    source.id,
    source.PlaceId,
    source.BusinessId
  );
  const name = firstText(
    source.name,
    source.placeName,
    source.place_name,
    source.title,
    source.businessName,
    source.Name,
    source.PlaceName,
    source.BusinessName
  );
  const isAd = Boolean(
    source.isAd === true ||
    source.is_ad === true ||
    source.isSponsored === true ||
    source.sponsored === true ||
    source.ad === true ||
    source.IsAd === true ||
    source.IsSponsored === true ||
    String(source.AdType || "").toLowerCase() === "sponsored" ||
    source.adId ||
    source.ad_id
  );
  const isErrorRecord = Boolean(source.error || source.errorMessage || source.error_message || source.failed === true);
  if (!name || (!id && !url) || isAd || isErrorRecord) return null;

  const sourceRank = positiveRank(
    source.organicRank,
    source.organic_rank,
    source.searchRank,
    source.search_rank,
    source.rank,
    source.position,
    source.Rank,
    source.Position
  );

  return {
    rank: index + 1,
    sourceRank,
    sourceIndex: index,
    id,
    placeIds: uniqueValues([id, ...extractPlaceIds(url)]),
    name,
    url,
    visitorReviewCount: firstMetricText(
      source.visitorReviewCount,
      source.visitor_reviews,
      source.reviewCount,
      source.reviewsCount,
      source.VisitorReviewCount,
      source.ReviewCount
    ),
    blogReviewCount: firstMetricText(
      source.blogCafeReviewCount,
      source.blogReviewCount,
      source.blog_reviews,
      source.blogCount,
      source.BlogReviewCount
    ),
    isAd: false,
  };
}

function normalizeApifyResult(items = [], maxRank = DEFAULT_MAX_RANK) {
  const sourceItems = flattenApifyItems(items);
  const candidates = [];
  const keys = new Set();
  let examinedItemCount = 0;
  for (const item of sourceItems) {
    examinedItemCount += 1;
    const candidate = apifyCandidate(item, candidates.length);
    if (!candidate) continue;
    const key = candidate.id || normalizeComparable(candidate.name + candidate.url);
    if (!key || keys.has(key)) continue;
    keys.add(key);
    candidates.push(candidate);
  }
  candidates.sort((left, right) => {
    const leftRank = Number(left.sourceRank || 0);
    const rightRank = Number(right.sourceRank || 0);
    if (leftRank && rightRank && leftRank !== rightRank) return leftRank - rightRank;
    if (leftRank && !rightRank) return -1;
    if (!leftRank && rightRank) return 1;
    return Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0);
  });
  const limitedCandidates = candidates
    .filter((candidate) => !candidate.sourceRank || candidate.sourceRank <= maxRank)
    .slice(0, maxRank)
    .map((candidate, index) => ({
      ...candidate,
      // Some providers return sparse partial rows with their true organic rank.
      // Preserve that evidence instead of renumbering the first returned row as 1.
      rank: candidate.sourceRank || index + 1,
    }));
  return {
    candidates: limitedCandidates,
    rawItemCount: Array.isArray(items) ? items.length : 0,
    flattenedItemCount: sourceItems.length,
    discardedItemCount: Math.max(0, examinedItemCount - candidates.length),
  };
}

function normalizeApifyCandidates(items = [], maxRank = DEFAULT_MAX_RANK) {
  return normalizeApifyResult(items, maxRank).candidates;
}

function apifyStopReason(normalized, maxRank = DEFAULT_MAX_RANK) {
  if (normalized.candidates.length >= maxRank) return "requested_range_checked";
  if (normalized.rawItemCount === 0) return "apify_empty_dataset";
  if (normalized.candidates.length === 0) return "apify_output_unrecognized";
  if (normalized.flattenedItemCount >= maxRank) return "apify_normalized_result_shortfall";
  return "apify_result_list_exhausted";
}

function resolveApifyBudgetMs(payload = {}) {
  const requested = Number(payload.apifyBudgetMs || payload.apify_budget_ms);
  const configured = Number(process.env.APIFY_NAVER_MAPS_TIMEOUT_MS || 135000);
  const candidate = Number.isFinite(requested) && requested > 0 ? requested : configured;
  // Browser fallback is capped at 80 seconds. Keeping the Actor chain at or
  // below 135 seconds lets both stages complete inside the 225-second caller.
  return Math.max(30_000, Math.min(135_000, Number.isFinite(candidate) ? candidate : 135_000));
}

function isApifyAccountLimitError(value) {
  return /monthly usage hard limit exceeded|usage limit exceeded|not enough credits|account.*limit/i.test(
    normalizeText(value)
  );
}

async function lookupNaverPlaceRankViaApify(payload = {}, fetchImpl = fetch) {
  const token = apifyToken();
  if (!token) return null;

  const keyword = normalizeText(payload.keyword);
  const maxRank = clampMaxRank(payload.maxRank || payload.max_rank);
  let target = {
    placeId: normalizeText(payload.placeId || payload.place_id),
    placeIds: extractPlaceIds(payload.placeUrl || payload.place_url),
    placeUrl: normalizeUrl(payload.placeUrl || payload.place_url),
    placeName: normalizeText(payload.placeName || payload.place_name),
  };
  const overallTimeoutMs = resolveApifyBudgetMs(payload);
  const overallDeadlineAt = Date.now() + overallTimeoutMs;
  const runActor = async (actorId, input) => {
      const normalizedActorId = normalizeText(actorId).toLowerCase();
      const configuredTimeoutMs = normalizedActorId.includes("delicious_zebu~naver-map-search-results-scraper") ||
        normalizedActorId.includes("solidcode~naver-map-scraper")
        ? Number(process.env.APIFY_NAVER_MAPS_DEEP_TIMEOUT_MS || 170000)
        : normalizedActorId.includes("oxygenated_quagmire~naver-place-search")
          ? Number(process.env.APIFY_NAVER_MAPS_PRIMARY_TIMEOUT_MS || 35000)
          : Number(process.env.APIFY_NAVER_MAPS_FALLBACK_TIMEOUT_MS || 40000);
      const remainingMs = overallDeadlineAt - Date.now();
      if (remainingMs <= 1000) throw new Error("apify_actor_chain_timeout");
      const requestTimeoutMs = Math.max(1000, Math.min(remainingMs, configuredTimeoutMs));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      const endpoint = new URL(
        `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`
      );
      endpoint.searchParams.set("token", token);
      endpoint.searchParams.set("timeout", String(Math.max(1, Math.floor(requestTimeoutMs / 1000))));
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        const bodyText = await response.text();
        let items = [];
        if (bodyText) {
          try {
            items = JSON.parse(bodyText);
          } catch {
            const contentType = response.headers.get("content-type") || "unknown";
            throw new Error(`apify_non_json_response:${response.status}:${contentType}`);
          }
        }
        if (!response.ok) {
          const message = items?.error?.message || items?.message || `apify_http_${response.status}`;
          throw new Error(message);
        }
        if (!Array.isArray(items)) throw new Error("apify_dataset_items_invalid");
        return items;
      } finally {
        clearTimeout(timeout);
      }
  };

    // Resolve short/share URLs without requiring a separate business-name field.
    if (!collectTargetIds(target).length && target.placeUrl) {
      const resolved = await resolvePlaceIdentityViaHttp(target.placeUrl, fetchImpl);
      target = {
        ...target,
        placeId: resolved.placeId || target.placeId,
        placeIds: uniqueValues([...(target.placeIds || []), ...(resolved.placeIds || []), resolved.placeId]),
        placeUrl: resolved.url || target.placeUrl,
        placeName: resolved.placeName || target.placeName,
      };
    }

    // If the share page itself does not expose an ID, use URL mode once.
    if (!collectTargetIds(target).length && target.placeUrl) {
      const identityItems = await runActor(
        APIFY_IDENTITY_ACTOR_ID,
        buildApifyIdentityInput(APIFY_IDENTITY_ACTOR_ID, target.placeUrl)
      );
      const identity = normalizeApifyCandidates(identityItems, 1)[0];
      if (identity) {
        target = {
          ...target,
          placeId: identity.id,
          placeIds: uniqueValues([...(target.placeIds || []), ...(identity.placeIds || []), identity.id]),
          placeUrl: identity.url || target.placeUrl,
          placeName: identity.name || target.placeName,
        };
      }
    }

    if (!collectTargetIds(target).length && !target.placeName) {
      return {
        ok: false,
        matched: false,
        checkedCount: 0,
        total: 0,
        requestedMaxRank: maxRank,
        complete: false,
        partial: true,
        partialReason: "place_identity_unresolved",
        stopReason: "place_identity_unresolved",
        place: { id: "", name: "", url: target.placeUrl },
        topPlaces: [],
        source: "apify_naver_maps_scraper",
        message: "플레이스 URL에서 장소 식별값을 확인하지 못했습니다.",
      };
    }

    const primaryActorId = APIFY_SEARCH_ACTOR_ID;
    const actorIds = uniqueValues([
      primaryActorId,
      APIFY_DEEP_SEARCH_ACTOR_ID,
      APIFY_FALLBACK_ACTOR_ID,
    ]);
    const actorAttempts = [];
    let selected = null;
    let primaryStopReason = null;

    for (const actorId of actorIds) {
      try {
        const items = await runActor(actorId, buildApifySearchInput(actorId, keyword, maxRank));
        const normalized = normalizeApifyResult(items, maxRank);
        const stopReason = apifyStopReason(normalized, maxRank);
        const matched = findMatch(normalized.candidates, target);
        actorAttempts.push({
          actorId,
          stopReason,
          rawItemCount: normalized.rawItemCount,
          normalizedItemCount: normalized.candidates.length,
          error: null,
        });
        if (actorId === APIFY_SEARCH_ACTOR_ID) primaryStopReason = stopReason;
        if (!selected || normalized.candidates.length > selected.normalized.candidates.length) {
          selected = { actorId, normalized, matched };
        }
        // A match inside the returned organic order already has a deterministic
        // rank. Otherwise continue until one Actor proves the full 300 range.
        if (matched || normalized.candidates.length >= maxRank) {
          selected = { actorId, normalized, matched };
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        actorAttempts.push({
          actorId,
          stopReason: "apify_actor_failed",
          rawItemCount: 0,
          normalizedItemCount: 0,
          error: message,
        });
        if (actorId === APIFY_SEARCH_ACTOR_ID) primaryStopReason = "apify_actor_failed";
        // All Actors share the same Apify account balance. Once the account
        // itself is blocked, trying the remaining Actors only burns request
        // time that the native Naver Map fallback needs.
        if (isApifyAccountLimitError(message)) break;
      }
    }

    if (!selected) {
      const failure = actorAttempts.map((attempt) => `${attempt.actorId}:${attempt.error || attempt.stopReason}`).join(" | ");
      throw new Error(failure || "apify_actor_chain_failed");
    }

    const { actorId, normalized, matched } = selected;
    const candidates = normalized.candidates;
    const fallbackUsed = actorId !== APIFY_SEARCH_ACTOR_ID;
    const complete = candidates.length >= maxRank;
    const stopReason = apifyStopReason(normalized, maxRank);
    return {
      ok: stopReason !== "apify_output_unrecognized",
      matched: Boolean(matched),
      rank: matched ? matched.rank : null,
      checkedCount: candidates.length,
      total: candidates.length,
      rawItemCount: normalized.rawItemCount,
      normalizedItemCount: candidates.length,
      discardedItemCount: normalized.discardedItemCount,
      actorId,
      primaryActorId,
      fallbackUsed,
      primaryStopReason: fallbackUsed ? primaryStopReason : null,
      primaryRawItemCount: fallbackUsed ? actorAttempts[0]?.rawItemCount ?? null : null,
      primaryNormalizedItemCount: fallbackUsed ? actorAttempts[0]?.normalizedItemCount ?? null : null,
      actorAttempts,
      requestedMaxRank: maxRank,
      complete,
      partial: !complete,
      partialReason: complete ? null : stopReason,
      stopReason,
      place: matched || {
        id: target.placeId || target.placeIds[0] || "",
        name: target.placeName,
        url: target.placeUrl,
      },
      metrics: aggregateCandidateMetrics(candidates),
      topPlaces: candidates.slice(0, 20),
      source: actorId.toLowerCase().includes("delicious_zebu~naver-map-search-results-scraper") ||
        actorId.toLowerCase().includes("solidcode~naver-map-scraper")
        ? "apify_naver_maps_deep_search"
        : actorId.toLowerCase().includes("abotapi~naver-map-scraper")
          ? fallbackUsed ? "apify_naver_maps_scraper_fallback" : "apify_naver_maps_scraper"
          : "apify_naver_place_search",
      message: matched
        ? `네이버 지도 오가닉 ${matched.rank}위로 확인되었습니다.`
        : complete
          ? `네이버 지도 오가닉 상위 ${maxRank}개 안에서 대상 플레이스를 찾지 못했습니다.`
          : stopReason === "apify_empty_dataset"
            ? "Apify 검색 Actor가 dataset 항목을 반환하지 않았습니다. 검색어와 Actor 실행 로그를 확인해주세요."
            : stopReason === "apify_output_unrecognized"
              ? "Apify 검색 Actor 출력에서 플레이스 항목을 인식하지 못했습니다. 출력 스키마를 확인해주세요."
              : stopReason === "apify_normalized_result_shortfall"
                ? `Apify 원본 ${normalized.flattenedItemCount}개 중 고유 오가닉 ${candidates.length}개만 확인되어 300위 확인을 완료하지 못했습니다.`
                : `네이버 지도 오가닉 ${candidates.length}개까지 확인했으며 300위 확인을 완료하지 못했습니다.`,
    };
}

function candidateCacheKey(keyword, maxRank) {
  return normalizeComparable(keyword) + ":" + maxRank;
}

function cachedCandidates(keyword, maxRank) {
  const key = candidateCacheKey(keyword, maxRank);
  const entry = resultCache.get(key);
  if (!entry || Date.now() - entry.cachedAt > RESULT_CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  resultCache.delete(key);
  resultCache.set(key, entry);
  return {
    ...entry.collection,
    candidates: entry.collection.candidates.map((candidate) => ({
      ...candidate,
      placeIds: [...(candidate.placeIds || [])],
    })),
  };
}

function rememberCandidates(keyword, maxRank, collection) {
  // Never fan out a short or transiently truncated list to every tracker that
  // shares a keyword. Only a fully collected requested range is cacheable.
  if (!collection.complete) return;
  const key = candidateCacheKey(keyword, maxRank);
  resultCache.delete(key);
  resultCache.set(key, {
    cachedAt: Date.now(),
    collection: {
      ...collection,
      candidates: collection.candidates.map((candidate) => ({
        ...candidate,
        placeIds: [...(candidate.placeIds || [])],
      })),
    },
  });
  while (resultCache.size > RESULT_CACHE_MAX) {
    resultCache.delete(resultCache.keys().next().value);
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("playwright_not_installed");
  }
}

async function resolvePlaceIdentityWithBrowser(context, value) {
  const originalUrl = normalizeUrl(value);
  const result = {
    url: originalUrl,
    placeId: extractPlaceId(originalUrl),
    placeIds: extractPlaceIds(originalUrl),
    placeName: "",
  };

  if (!/^https?:\/\//i.test(originalUrl)) return result;

  const page = await context.newPage();
  try {
    await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await page.waitForTimeout(2500);

    result.url = normalizeText(page.url()) || originalUrl;
    result.placeIds = uniqueValues([...result.placeIds, ...extractPlaceIds(result.url)]);
    result.placeId = result.placeId || result.placeIds[0] || "";

    for (const frame of page.frames()) {
      const frameUrl = frame.url();
      const detailMatch = frameUrl.match(DETAIL_FRAME_PATTERN);
      result.placeIds = uniqueValues([...result.placeIds, ...extractPlaceIds(frameUrl), detailMatch?.[1]]);
      result.placeId = result.placeId || result.placeIds[0] || "";
    }

    const pageTitle = cleanPlaceTitle(await page.title().catch(() => ""));
    const metaTitle = cleanPlaceTitle(await page
      .locator("meta[property='og:title']")
      .getAttribute("content", { timeout: IDENTITY_OPTIONAL_SELECTOR_TIMEOUT_MS })
      .catch(() => ""));
    const metaUrl = await page
      .locator("meta[property='og:url']")
      .getAttribute("content", { timeout: IDENTITY_OPTIONAL_SELECTOR_TIMEOUT_MS })
      .catch(() => "");
    const canonicalUrl = await page
      .locator("link[rel='canonical']")
      .getAttribute("href", { timeout: IDENTITY_OPTIONAL_SELECTOR_TIMEOUT_MS })
      .catch(() => "");
    result.placeIds = uniqueValues([...result.placeIds, ...extractPlaceIds(metaUrl), ...extractPlaceIds(canonicalUrl)]);
    result.placeId = result.placeId || result.placeIds[0] || "";
    const frameTitles = [];
    for (const frame of page.frames()) {
      if (!DETAIL_FRAME_PATTERN.test(frame.url())) continue;
      const title = await frame
        .locator("span.Fc1rA, h1, [class*='place_bluelink'], [class*='GHAhO'], [class*='YouOG']")
        .first()
        .innerText({ timeout: IDENTITY_OPTIONAL_SELECTOR_TIMEOUT_MS })
        .catch(() => "");
      if (title) frameTitles.push(cleanPlaceTitle(title));
    }

    result.placeName = [...frameTitles, metaTitle, pageTitle].find(isLikelyPlaceName) || "";
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

async function waitForListFrame(page) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    const frame = page.frames().find((item) => LIST_FRAME_PATTERN.test(item.url()));
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error("naver_map_list_frame_not_found");
}

async function extractVisibleRows(frame) {
  return await frame.evaluate(() => {
    const listRoot = document.querySelector("#_pcmap_list_scroll_container");
    const root = listRoot || document.body;
    // Promotional carousels such as "새로 오픈했어요" render nested <li>
    // elements inside a real place card. Only top-level list rows represent
    // organic rank positions.
    const rows = Array.from(root.querySelectorAll("li")).filter((row) => {
      const ancestorListItem = row.parentElement?.closest("li");
      return !ancestorListItem || !root.contains(ancestorListItem);
    });
    return rows.map((row, visibleIndex) => {
      const findPlaceItem = () => {
        const seen = new WeakSet();
        let visited = 0;
        const walk = (value, depth = 0) => {
          if (!value || typeof value !== "object" || depth > 12 || visited > 1200) return null;
          if (seen.has(value)) return null;
          seen.add(value);
          visited += 1;

          const id = String(value.id || value.apolloCacheId || "");
          const name = typeof value.name === "string" ? value.name.trim() : "";
          if (/^\d{5,}$/.test(id) && name.length >= 2) return value;

          for (const key of Object.keys(value)) {
            if (["_owner", "return", "child", "sibling", "stateNode"].includes(key)) continue;
            let found = null;
            try {
              found = walk(value[key], depth + 1);
            } catch {
              found = null;
            }
            if (found) return found;
          }
          return null;
        };

        for (const key of Object.keys(row)) {
          if (!key.startsWith("__reactProps") && !key.startsWith("__reactFiber")) continue;
          const found = walk(row[key]);
          if (found) return found;
        }
        return null;
      };

      const placeItem = findPlaceItem();
      const text = (row.textContent || "").replace(/\s+/g, " ").trim();
      const adLink = row.querySelector("a[href*='help.naver.com/support/alias/NSP/NSP_53']");
      const exactAdControl = Array.from(row.querySelectorAll("a, button, [role='button']"))
        .some((node) => (node.textContent || "").replace(/\s+/g, " ").trim() === "광고");
      const placeId = String(placeItem?.id || placeItem?.apolloCacheId || "");
      if (placeId && placeItem?.name) {
        return {
          visibleIndex,
          isPlaceListRow: Boolean(listRoot),
          id: placeId,
          text,
          aria: "",
          url: `https://map.naver.com/p/entry/place/${placeId}`,
          hrefs: [],
          html: "",
          isAd: Boolean(placeItem.adId || placeItem.adClickLog || placeItem.adDescription || adLink || exactAdControl),
          nameNodes: [placeItem.name],
          visitorReviewCount: placeItem.visitorReviewCount ?? "",
          blogReviewCount: placeItem.blogCafeReviewCount ?? "",
        };
      }

      const nameNodes = Array.from(row.querySelectorAll("span, strong, a, div"))
        .map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const anchor = row.querySelector("a[href*='/place/'], a[href*='/restaurant/'], a[href*='/entry/place/']");
      const hrefs = Array.from(row.querySelectorAll("a[href]"))
        .map((node) => node.href || node.getAttribute("href") || "")
        .filter(Boolean);
      const url = anchor?.href || anchor?.getAttribute("href") || "";
      const aria = row.getAttribute("aria-label") || "";
      return {
        visibleIndex,
        isPlaceListRow: Boolean(listRoot),
        id: placeId,
        text,
        aria,
        url,
        hrefs,
        html: (row.outerHTML || "").slice(0, 12000),
        isAd: Boolean(adLink || exactAdControl),
        nameNodes: nameNodes.slice(0, 12),
        visitorReviewCount: "",
        blogReviewCount: "",
      };
    }).filter((row) => row.text || row.aria || row.url);
  });
}

function rowNameFromRaw(row) {
  const rawCandidates = [
    row.aria,
    ...(Array.isArray(row.nameNodes) ? row.nameNodes : []),
    row.text,
  ];

  for (const raw of rawCandidates) {
    const name = cleanRowName(raw);
    if (isLikelyPlaceName(name) && !AD_HINT_PATTERN.test(name)) return name;
  }

  const firstLine = normalizeText(row.text).split(/\s+(?:방문자리뷰|블로그리뷰|리뷰|별점|영업|거리뷰|길찾기|예약|광고)\b/)[0];
  return cleanRowName(firstLine);
}

function appendCandidate(items, rawRow) {
  if (!rawRow || rawRow.isAd) return false;
  const name = rowNameFromRaw(rawRow);
  if (!isLikelyPlaceName(name)) return false;

  const placeIds = collectCandidateIds(rawRow);
  const id = placeIds[0] || "";
  const key = placeIds.length ? placeIds.join("|") : normalizeComparable(name + normalizeText(rawRow.text).slice(0, 80));
  const isDuplicate = items.some((item) =>
    item.key === key || (placeIds.length > 0 && placeIds.some((placeId) => item.placeIds.includes(placeId)))
  );
  if (!key || isDuplicate) return false;

  items.push({
    key,
    rank: items.length + 1,
    id,
    placeIds,
    name,
    url: rawRow.url || "",
    hrefs: Array.isArray(rawRow.hrefs) ? rawRow.hrefs : [],
    aria: normalizeText(rawRow.aria),
    html: rawRow.html || "",
    text: normalizeText(rawRow.text || rawRow.aria),
    visitorReviewCount: firstMetricText(rawRow.visitorReviewCount),
    blogReviewCount: firstMetricText(rawRow.blogReviewCount),
    isAd: false,
  });
  return true;
}

function toPublicCandidate(candidate, index) {
  return {
    rank: index + 1,
    id: candidate.id,
    placeIds: candidate.placeIds,
    name: candidate.name,
    url: candidate.url,
    visitorReviewCount: candidate.visitorReviewCount,
    blogReviewCount: candidate.blogReviewCount,
    isAd: false,
  };
}

function nextListScrollTop(state = {}) {
  const scrollTop = Math.max(0, Number(state.scrollTop || 0));
  const scrollHeight = Math.max(0, Number(state.scrollHeight || 0));
  const clientHeight = Math.max(1, Number(state.clientHeight || 0));
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const overlappingStep = Math.max(320, Math.floor(clientHeight * 0.72));
  return Math.min(maxScrollTop, scrollTop + overlappingStep);
}

async function scrollListFrame(frame) {
  const state = await frame.evaluate(() => {
    const root = document.querySelector("#_pcmap_list_scroll_container");
    if (!root) {
      return {
        useWindow: true,
        scrollTop: window.scrollY,
        scrollHeight: document.body.scrollHeight,
        clientHeight: window.innerHeight,
      };
    }
    return {
      useWindow: false,
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    };
  });
  const nextScrollTop = nextListScrollTop(state);
  return await frame.evaluate(({ nextScrollTop: next, useWindow }) => {
    const root = document.querySelector("#_pcmap_list_scroll_container");
    if (!root || useWindow) {
      window.scrollTo(0, next);
      window.dispatchEvent(new Event("scroll"));
      return {
        scrollTop: window.scrollY,
        scrollHeight: document.body.scrollHeight,
        clientHeight: window.innerHeight,
      };
    }
    // Naver virtualizes the PC list. An end jump can skip middle rows that
    // never enter the DOM, so advance with overlap and ingest every viewport.
    root.scrollTop = next;
    root.dispatchEvent(new Event("scroll", { bubbles: true }));
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    };
  }, { nextScrollTop, useWindow: Boolean(state.useWindow) });
}

function collectionResult(candidates, resultLimit, stopReason, scrollCount = 0) {
  const publicCandidates = candidates.slice(0, resultLimit).map(toPublicCandidate);
  const complete = publicCandidates.length >= resultLimit;
  return {
    candidates: publicCandidates,
    complete,
    stopReason: complete ? "requested_range_checked" : stopReason,
    scrollCount,
  };
}

function selectorFallbackCollection(_previewCandidates = [], domRows = [], resultLimit = NAVER_PLACE_MAX_RESULTS) {
  const candidates = [];
  let identifiedCandidateCount = 0;
  // /p/api/search/allSearch is a map-marker preview. Its order can diverge
  // from the PC place list, so it must never become organic-rank evidence.
  // Only rows proven to come from Naver's place-list scroll container are
  // rank evidence. Body-wide menu/list rows must never inflate a rank.
  // Within that verified list, ID-less organic rows still occupy a real
  // position and must remain so a later target is never shifted upward.
  domRows.filter((row) => row?.isPlaceListRow === true).forEach((row) => {
    const appended = appendCandidate(candidates, row);
    if (appended && collectCandidateIds(row).length > 0) identifiedCandidateCount += 1;
  });

  // A body-wide fallback containing only labels/menu rows is not rank proof.
  if (!candidates.length || identifiedCandidateCount === 0) return null;
  const publicCandidates = candidates
    .slice(0, Math.min(resultLimit, NAVER_PLACE_MAX_RESULTS))
    .map(toPublicCandidate);
  return {
    candidates: publicCandidates,
    complete: false,
    stopReason: "list_selector_unavailable_fallback",
    scrollCount: 0,
  };
}

function atScrollEnd(state = {}) {
  const scrollTop = Number(state.scrollTop || 0);
  const scrollHeight = Number(state.scrollHeight || 0);
  const clientHeight = Number(state.clientHeight || 0);
  return scrollTop + clientHeight >= scrollHeight - 2;
}

function sameScrollState(left, right) {
  if (!left || !right) return false;
  return Number(left.scrollTop) === Number(right.scrollTop) &&
    Number(left.scrollHeight) === Number(right.scrollHeight);
}

async function collectRowsProgressively({
  resultLimit,
  maxScrolls,
  deadlineAt,
  readRows,
  advance,
  wait,
  now = Date.now,
  growthPollAttempts = GROWTH_POLL_ATTEMPTS,
  growthPollIntervalMs = GROWTH_POLL_INTERVAL_MS,
  exhaustedStableRounds = EXHAUSTED_STABLE_ROUNDS,
}) {
  const candidates = [];
  let previousScrollState = null;
  let stableRounds = 0;
  let scrollCount = 0;

  const ingestRows = async () => {
    const rows = await readRows();
    for (const row of rows) appendCandidate(candidates, row);
  };

  while (true) {
    await ingestRows();
    if (candidates.length >= resultLimit) {
      return collectionResult(candidates, resultLimit, "requested_range_checked", scrollCount);
    }
    if (now() >= deadlineAt) {
      return collectionResult(candidates, resultLimit, "collection_deadline_reached", scrollCount);
    }
    if (scrollCount >= maxScrolls) {
      return collectionResult(candidates, resultLimit, "max_scrolls_reached", scrollCount);
    }

    const countBeforeScroll = candidates.length;
    const scrollState = await advance();
    scrollCount += 1;

    // Mid-list virtual scrolling does not need six idle polls before the next
    // overlapping step. Keep the longer wait only at the current list end,
    // where Naver may still append another result batch.
    const pollAttempts = atScrollEnd(scrollState)
      ? growthPollAttempts
      : Math.min(2, growthPollAttempts);
    for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
      if (now() >= deadlineAt) {
        return collectionResult(candidates, resultLimit, "collection_deadline_reached", scrollCount);
      }
      await wait(growthPollIntervalMs);
      await ingestRows();
      if (candidates.length >= resultLimit) {
        return collectionResult(candidates, resultLimit, "requested_range_checked", scrollCount);
      }
      if (candidates.length > countBeforeScroll) break;
    }

    const noGrowth = candidates.length === countBeforeScroll;
    const settledAtEnd = atScrollEnd(scrollState) || sameScrollState(scrollState, previousScrollState);
    stableRounds = noGrowth && settledAtEnd ? stableRounds + 1 : 0;
    if (stableRounds >= exhaustedStableRounds) {
      return collectionResult(candidates, resultLimit, "naver_result_list_exhausted", scrollCount);
    }
    previousScrollState = scrollState;
  }
}

async function collectVerifiedListRowsProgressively({
  resultLimit,
  maxScrolls,
  deadlineAt,
  readRows,
  advance,
  wait,
  selectorError,
  now = Date.now,
  ...progressOptions
}) {
  if (now() >= deadlineAt) {
    return collectionResult([], resultLimit, "collection_deadline_reached", 0);
  }
  let initialRead;
  try {
    initialRead = await readRows();
  } catch (error) {
    // A failed viewport read cannot be treated as an empty page. Skipping it
    // would pull every later organic result forward by one or more ranks.
    throw selectorError || error;
  }
  const initialRows = initialRead.filter((row) => row?.isPlaceListRow === true);
  if (!initialRows.length) {
    throw selectorError || new Error("naver_place_list_rows_unavailable");
  }

  let useInitialRows = true;
  return collectRowsProgressively({
    resultLimit,
    maxScrolls,
    deadlineAt,
    readRows: async () => {
      if (useInitialRows) {
        useInitialRows = false;
        return initialRows;
      }
      return (await readRows()).filter((row) => row?.isPlaceListRow === true);
    },
    advance,
    wait,
    now,
    ...progressOptions,
  });
}

function buildPlaceListUrl(keyword, maxRank, searchCoord = "") {
  const [x = "126.891732", y = "37.476909"] = normalizeText(searchCoord).split(";");
  const mapUrl = NAVER_MAP_SEARCH_BASE + encodeURIComponent(keyword);
  const url = new URL(NAVER_PLACE_LIST_BASE);
  url.searchParams.set("query", keyword);
  url.searchParams.set("x", x || "126.891732");
  url.searchParams.set("y", y || "37.476909");
  url.searchParams.set("display", String(Math.min(maxRank, 300)));
  url.searchParams.set("ts", String(Date.now()));
  url.searchParams.set("additionalHeight", "76");
  url.searchParams.set("locale", "ko");
  url.searchParams.set("mapUrl", mapUrl);
  url.searchParams.set("svcName", "map_pcv5");
  return url.toString();
}

function candidateFromAllSearch(item, index) {
  const id = normalizeText(item?.id || item?.placeId || item?.businessId);
  const name = normalizeText(item?.name || item?.display || item?.title);
  if (!id || !name) return null;
  if (item?.adId || item?.adClickLog || item?.adDescription || item?.isAd === true) return null;

  return {
    rank: Number(item?.rank || index + 1),
    id,
    placeIds: [id],
    name,
    url: `https://map.naver.com/p/entry/place/${id}`,
    visitorReviewCount: firstMetricText(item?.visitorReviewCount, item?.placeReviewCount),
    blogReviewCount: firstMetricText(item?.blogCafeReviewCount, item?.reviewCount),
    isAd: false,
  };
}

async function resolveMapSearch(page, keyword) {
  const responsePromise = page
    .waitForResponse((response) => response.url().includes("/p/api/search/allSearch"), { timeout: 15000 })
    .catch(() => null);
  await page.goto(NAVER_MAP_SEARCH_BASE + encodeURIComponent(keyword), {
    waitUntil: "domcontentloaded",
    timeout: Math.min(DEFAULT_TIMEOUT_MS, 30000),
  });
  const response = await responsePromise;
  if (!response) return { searchCoord: "", candidates: [], total: 0 };
  try {
    const payload = await response.json();
    const placeResult = payload?.result?.place;
    const candidates = (Array.isArray(placeResult?.list) ? placeResult.list : [])
      .map(candidateFromAllSearch)
      .filter(Boolean);
    return {
      searchCoord: new URL(response.url()).searchParams.get("searchCoord") || "",
      candidates,
      total: Number(placeResult?.totalCount || candidates.length || 0),
    };
  } catch {
    return { searchCoord: "", candidates: [], total: 0 };
  }
}

async function collectCandidatesFromNaverMap(context, keyword, maxRank, deadlineAt) {
  const cached = cachedCandidates(keyword, maxRank);
  if (cached) return cached;

  const page = await context.newPage();
  try {
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    const shouldDeepScan = DEEP_SCAN || maxRank > 100;
    if (!shouldDeepScan) {
      await page.goto(buildPlaceListUrl(keyword, maxRank), {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT_MS,
        referer: NAVER_MAP_SEARCH_BASE + encodeURIComponent(keyword),
      });
      const selectorError = await page
        .waitForSelector("#_pcmap_list_scroll_container li", { timeout: LIST_SELECTOR_TIMEOUT_MS })
        .then(() => null)
        .catch((error) => error);

      const restrictionText = normalizeText(await page.locator("body").innerText().catch(() => ""));
      if (/서비스 이용이 제한되었습니다|과도한 접근 요청/.test(restrictionText)) {
        throw new Error("naver_place_access_limited");
      }

      const resultLimit = Math.min(maxRank, NAVER_PLACE_MAX_RESULTS);
      const collection = await collectVerifiedListRowsProgressively({
        resultLimit,
        maxScrolls: DEFAULT_MAX_SCROLLS,
        deadlineAt,
        readRows: () => extractVisibleRows(page),
        advance: () => scrollListFrame(page),
        wait: (milliseconds) => page.waitForTimeout(milliseconds),
        selectorError,
      });
      rememberCandidates(keyword, maxRank, collection);
      return collection;
    }

    // Ranking uses one neutral keyword search context. Coordinates embedded in
    // the tracked place URL describe the target and must not bias list order.
    const initialSearch = await resolveMapSearch(page, keyword);
    const searchCoord = initialSearch.searchCoord;
    await page.goto(buildPlaceListUrl(keyword, maxRank, searchCoord), {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT_MS,
      referer: NAVER_MAP_SEARCH_BASE + encodeURIComponent(keyword),
    });
    const selectorError = await page
      .waitForSelector("#_pcmap_list_scroll_container li", { timeout: LIST_SELECTOR_TIMEOUT_MS })
      .then(() => null)
      .catch((error) => error);
    await page.waitForTimeout(900);

    const restrictionText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    if (/서비스 이용이 제한되었습니다|과도한 접근 요청/.test(restrictionText)) {
      throw new Error("naver_place_access_limited");
    }

    const resultLimit = Math.min(maxRank, NAVER_PLACE_MAX_RESULTS);
    const collection = await collectVerifiedListRowsProgressively({
      resultLimit,
      maxScrolls: DEFAULT_MAX_SCROLLS,
      deadlineAt,
      readRows: () => extractVisibleRows(page),
      advance: () => scrollListFrame(page),
      wait: (milliseconds) => page.waitForTimeout(milliseconds),
      selectorError,
    });
    rememberCandidates(keyword, maxRank, collection);
    return collection;
  } finally {
    await page.close().catch(() => {});
  }
}

async function findVerifiedMatchByClick(context, keyword, target, maxRank) {
  const targetIds = collectTargetIds(target);
  const targetId = targetIds[0] || "";
  if (!targetIds.length && !normalizeText(target.placeName)) return null;

  const page = await context.newPage();
  try {
    await page.goto(NAVER_MAP_SEARCH_BASE + encodeURIComponent(keyword), { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    const frame = await waitForListFrame(page);
    await frame.waitForSelector("#_pcmap_list_scroll_container li, li", { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1200);

    let organicRank = 0;
    const seen = new Set();
    let previousScrollTop = -1;
    let stableCount = 0;

    for (let scroll = 0; scroll <= DEFAULT_MAX_SCROLLS; scroll += 1) {
      const rows = await frame.locator("#_pcmap_list_scroll_container li").all().catch(() => []);
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const text = normalizeText(await row.innerText().catch(() => ""));
        const isAd = AD_HINT_PATTERN.test(text) || (await row.locator("a[href*='help.naver.com/support/alias/NSP/NSP_53']").count().catch(() => 0)) > 0;
        const name = rowNameFromRaw({ text, nameNodes: [text], isAd });
        const key = normalizeComparable(name + text.slice(0, 80));
        if (!key || seen.has(key) || isAd) continue;
        seen.add(key);
        organicRank += 1;
        if (organicRank > maxRank) return null;

        const hrefs = await row.locator("a[href]").evaluateAll((nodes) =>
          nodes.map((node) => node.href || node.getAttribute("href") || "").filter(Boolean)
        ).catch(() => []);
        const aria = await row.getAttribute("aria-label").catch(() => "");
        const html = await row.evaluate((node) => (node.outerHTML || "").slice(0, 12000)).catch(() => "");
        const candidate = {
          name,
          text,
          aria,
          hrefs,
          html,
          url: hrefs.find((href) => /\/(?:entry\/place|place|restaurant|hospital|accommodation|hairshop|beauty|attraction|shopping)\//i.test(href)) || "",
        };
        const candidateIds = collectCandidateIds(candidate);
        const shouldVerifyByClick =
          candidateMatchesTarget(candidate, target) ||
          (targetIds.length > 0 && candidateIds.length === 0) ||
          (targetIds.length > 0 && getCandidatePlaceUrl(candidate));

        if (!shouldVerifyByClick) continue;

        const placeLink = row
          .locator(
            "a[href*='m.place.naver.com'], a[href*='pcmap.place.naver.com'], a[href*='/entry/place/'], a[href*='/place/'], a[href*='/restaurant/'], a[href*='/hospital/'], a[href*='/accommodation/'], a[href*='/hairshop/'], a[href*='/beauty/'], a[href*='/attraction/'], a[href*='/shopping/']"
          )
          .first();
        const hasPlaceLink = (await placeLink.count().catch(() => 0)) > 0;
        if (hasPlaceLink) {
          await placeLink.click({ timeout: 3000 }).catch(() => row.click({ timeout: 3000 }));
        } else {
          await row.locator("a, button").first().click({ timeout: 3000 }).catch(() => row.click({ timeout: 3000 }));
        }
        await page.waitForTimeout(1200);
        const urls = [page.url(), ...page.frames().map((item) => item.url())].join("\n");
        const clickedIds = extractPlaceIds(urls);
        if (!targetIds.length || clickedIds.some((id) => targetIds.includes(id))) {
          return {
            rank: organicRank,
            id: targetId || clickedIds[0] || "",
            placeIds: uniqueValues([...targetIds, ...clickedIds]),
            name,
            url: page.url(),
            text,
            isAd: false,
          };
        }
      }

      const scrollState = await scrollListFrame(frame);
      await page.waitForTimeout(850);
      const scrollTop = Number(scrollState.scrollTop);
      stableCount = scrollTop === previousScrollTop ? stableCount + 1 : 0;
      if (stableCount >= 3) break;
      previousScrollTop = scrollTop;
    }
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

function findMatch(candidates, target) {
  const targetIds = collectTargetIds(target);
  return candidates.find((candidate) => {
    const candidateIds = collectCandidateIds(candidate);
    if (targetIds.length && candidateIds.some((id) => targetIds.includes(id))) return true;
    return candidateMatchesTarget(candidate, target);
  }) || null;
}

function needsBrowserIdentityResolution(placeUrl, placeId) {
  if (!placeUrl) return false;
  if (normalizeText(placeId)) return false;
  return extractPlaceIds(placeUrl).length === 0;
}

function finalizeProviderFallback(apifyPartialResult, apifyFailure, browserResult) {
  const selectedResult = apifyPartialResult && !browserResult.matched &&
    Number(apifyPartialResult.checkedCount || 0) >= Number(browserResult.checkedCount || 0)
    ? apifyPartialResult
    : browserResult;
  if (!apifyFailure && !apifyPartialResult) return selectedResult;
  return {
    ...selectedResult,
    providerFallbackUsed: true,
    providerFallbackReason: apifyFailure || apifyPartialResult?.stopReason || "apify_partial_result",
    providerPartialCheckedCount: apifyPartialResult ? Number(apifyPartialResult.checkedCount || 0) : null,
    source: selectedResult === browserResult
      ? String(browserResult.source || "naver_map_pc_list_collector") + "_fallback"
      : selectedResult.source,
  };
}

export async function lookupNaverPlaceRank(payload = {}, dependencies = {}) {
  const keyword = normalizeText(payload.keyword);
  const maxRank = clampMaxRank(payload.maxRank || payload.max_rank);
  const placeUrl = normalizeUrl(payload.placeUrl || payload.place_url);
  let placeName = normalizeText(payload.placeName || payload.place_name);
  let placeId = normalizeText(payload.placeId || payload.place_id);

  if (!keyword) {
    return { ok: false, matched: false, message: "keyword_required" };
  }

  let apifyPartialResult = null;
  let apifyFailure = "";
  try {
    const apifyLookup = dependencies.apifyLookup || lookupNaverPlaceRankViaApify;
    const apifyResult = await apifyLookup(payload);
    if (apifyResult?.ok !== false && (apifyResult?.matched || apifyResult?.complete)) return apifyResult;
    if (apifyResult?.ok !== false && apifyResult) apifyPartialResult = apifyResult;
    else if (apifyResult) apifyFailure = normalizeText(apifyResult.message || apifyResult.stopReason || "apify_lookup_failed");
  } catch (error) {
    apifyFailure = error instanceof Error ? error.message : String(error);
  }

  if (dependencies.browserLookup) {
    const browserResult = await dependencies.browserLookup(payload);
    return finalizeProviderFallback(apifyPartialResult, apifyFailure, browserResult);
  }

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: HEADLESS });
  let overallTimeout;
  try {
    const collectionDeadlineAt = Date.now() + Math.max(1000, OVERALL_TIMEOUT_MS - COLLECTION_DEADLINE_GUARD_MS);
    const lookup = (async () => {
      const context = await browser.newContext({
        locale: "ko-KR",
        timezoneId: "Asia/Seoul",
        viewport: { width: 1440, height: 1000 },
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      });

      // Trackers persist the canonical place ID after the first resolution.
      // Resolving the same short URL on every refresh adds a second browser
      // navigation and can exhaust the hosted collector request budget.
      const resolved = needsBrowserIdentityResolution(placeUrl, placeId)
        ? await resolvePlaceIdentityWithBrowser(context, placeUrl)
        : { url: placeUrl, placeId: "", placeIds: [], placeName: "" };
      const placeIds = uniqueValues([
        placeId,
        resolved.placeId,
        ...(Array.isArray(resolved.placeIds) ? resolved.placeIds : []),
        ...extractPlaceIds(placeUrl),
        ...extractPlaceIds(resolved.url),
      ]);
      placeId = placeId || placeIds[0] || "";
      placeName = placeName || resolved.placeName;

      if (!placeId && !placeName) {
        return {
          ok: false,
          matched: false,
          checkedCount: 0,
          total: 0,
          message: "플레이스 URL에서 장소 식별 정보를 확인하지 못했습니다.",
          source: "naver_map_browser_collector",
        };
      }

      const target = {
        placeId,
        placeIds,
        placeUrl: resolved.url || placeUrl,
        placeName,
      };
      const collection = await collectCandidatesFromNaverMap(
        context,
        keyword,
        maxRank,
        collectionDeadlineAt
      );
      const candidates = collection.candidates;
      let matched = findMatch(candidates, target);
      const collectionStatus = buildCollectionStatus(collection, maxRank);

      const place = matched || {
        id: placeId,
        name: placeName,
        url: resolved.url || placeUrl,
      };

      return {
        ok: true,
        matched: Boolean(matched),
        rank: matched ? matched.rank : null,
        ...collectionStatus,
        place,
        metrics: aggregateCandidateMetrics(candidates),
        topPlaces: candidates.slice(0, 20),
        source: "naver_map_pc_list_collector",
        message: matched
          ? "네이버 지도 오가닉 " + matched.rank + "위로 확인되었습니다."
          : collectionStatus.partial
            ? "네이버 지도 오가닉 " + candidates.length + "개까지 부분 확인했으며 대상 플레이스를 찾지 못했습니다."
            : "네이버 지도 오가닉 상위 " + candidates.length + "개 안에서 대상 플레이스를 찾지 못했습니다.",
      };
    })();

    const timeout = new Promise((_, reject) => {
      overallTimeout = setTimeout(() => reject(new Error("naver_map_lookup_timeout")), OVERALL_TIMEOUT_MS);
    });
    const browserResult = await Promise.race([lookup, timeout]);
    return finalizeProviderFallback(apifyPartialResult, apifyFailure, browserResult);
  } finally {
    clearTimeout(overallTimeout);
    await browser.close().catch(() => {});
  }
}

function buildCollectionStatus(collection, requestedMaxRank) {
  const checkedCount = Math.min(collection.candidates.length, requestedMaxRank);
  const complete = collection.complete === true && checkedCount >= requestedMaxRank;
  const stopReason = complete
    ? "requested_range_checked"
    : collection.stopReason || "collection_incomplete";
  return {
    checkedCount,
    total: checkedCount,
    requestedMaxRank,
    complete,
    partial: !complete,
    partialReason: complete ? null : stopReason,
    stopReason,
  };
}

export const __testing = {
  apifyCandidate,
  aggregateCandidateMetrics,
  appendCandidate,
  apifyStopReason,
  buildCollectionStatus,
  buildApifyIdentityInput,
  buildApifySearchInput,
  clampMaxRank,
  candidateMatchesTarget,
  collectRowsProgressively,
  collectVerifiedListRowsProgressively,
  findMatch,
  lookupNaverPlaceRankViaApify,
  needsBrowserIdentityResolution,
  resolvePlaceIdentityViaHttp,
  resolveApifyBudgetMs,
  normalizeApifyCandidates,
  normalizeApifyResult,
  nextListScrollTop,
  isApifyAccountLimitError,
  finalizeProviderFallback,
  selectorFallbackCollection,
};

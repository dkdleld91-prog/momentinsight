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

const NAVER_MAP_SEARCH_BASE = "https://map.naver.com/p/search/";
const NAVER_PLACE_LIST_BASE = "https://pcmap.place.naver.com/place/list";
const NAVER_PLACE_MAX_RESULTS = 300;
const COLLECTION_DEADLINE_GUARD_MS = 5000;
const GROWTH_POLL_INTERVAL_MS = 220;
const GROWTH_POLL_ATTEMPTS = 6;
const EXHAUSTED_STABLE_ROUNDS = 3;
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
  if (targetIds.length && candidateIds.some((id) => targetIds.includes(id))) return true;

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

function firstText(...values) {
  return values.map(normalizeText).find(Boolean) || "";
}

function apifyCandidate(item = {}, index = 0) {
  const url = firstText(item.url, item.placeUrl, item.place_url, item.link, item.webUrl, item.web_url);
  const id = firstText(
    item.placeId,
    item.place_id,
    item.businessId,
    item.business_id,
    item.cid,
    extractPlaceId(url),
    item.id
  );
  const name = firstText(item.name, item.placeName, item.place_name, item.title, item.businessName);
  const isAd = Boolean(
    item.isAd === true ||
    item.is_ad === true ||
    item.sponsored === true ||
    item.ad === true ||
    item.adId ||
    item.ad_id
  );
  if ((!id && !name) || isAd) return null;

  return {
    rank: index + 1,
    id,
    placeIds: uniqueValues([id, ...extractPlaceIds(url)]),
    name,
    url,
    visitorReviewCount: firstText(
      item.visitorReviewCount,
      item.visitor_reviews,
      item.reviewCount,
      item.reviewsCount
    ),
    blogReviewCount: firstText(
      item.blogCafeReviewCount,
      item.blogReviewCount,
      item.blog_reviews,
      item.blogCount
    ),
    isAd: false,
  };
}

function normalizeApifyCandidates(items = [], maxRank = DEFAULT_MAX_RANK) {
  const candidates = [];
  const keys = new Set();
  for (const item of items) {
    const candidate = apifyCandidate(item, candidates.length);
    if (!candidate) continue;
    const key = candidate.id || normalizeComparable(candidate.name + candidate.url);
    if (!key || keys.has(key)) continue;
    keys.add(key);
    candidate.rank = candidates.length + 1;
    candidates.push(candidate);
    if (candidates.length >= maxRank) break;
  }
  return candidates;
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
  const controller = new AbortController();
  const timeoutMs = Math.max(
    30000,
    Math.min(230000, Number(process.env.APIFY_NAVER_MAPS_TIMEOUT_MS || 220000))
  );
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const runActor = async (actorId, input) => {
      const endpoint = new URL(
        `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`
      );
      endpoint.searchParams.set("token", token);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      const items = bodyText ? JSON.parse(bodyText) : [];
      if (!response.ok) {
        const message = items?.error?.message || items?.message || `apify_http_${response.status}`;
        throw new Error(message);
      }
      if (!Array.isArray(items)) throw new Error("apify_dataset_items_invalid");
      return items;
    };

    // A short naver.me URL does not contain a place ID. Resolve it once through
    // the Actor's URL mode, then reuse the canonical ID/name for rank matching.
    if ((!collectTargetIds(target).length || !target.placeName) && target.placeUrl) {
      const identityItems = await runActor(APIFY_IDENTITY_ACTOR_ID, {
        mode: "url",
        startUrls: [{ url: target.placeUrl }],
        includeDetails: false,
        includeReviews: false,
        maxItems: 1,
      });
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

    const items = await runActor(APIFY_SEARCH_ACTOR_ID, {
        queries: [keyword],
        maxResults: maxRank,
        includePhotos: false,
        includeReviewSnippets: false,
        proxyConfiguration: { useApifyProxy: true },
    });

    const candidates = normalizeApifyCandidates(items, maxRank);
    const matched = findMatch(candidates, target);
    const complete = candidates.length >= maxRank;
    const stopReason = complete ? "requested_range_checked" : "apify_result_list_exhausted";
    return {
      ok: true,
      matched: Boolean(matched),
      rank: matched ? matched.rank : null,
      checkedCount: candidates.length,
      total: candidates.length,
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
      topPlaces: candidates.slice(0, 20),
      source: "apify_naver_place_search",
      message: matched
        ? `네이버 지도 오가닉 ${matched.rank}위로 확인되었습니다.`
        : complete
          ? `네이버 지도 오가닉 상위 ${maxRank}개 안에서 대상 플레이스를 찾지 못했습니다.`
          : `네이버 지도 오가닉 ${candidates.length}개까지 확인했으며 300위 확인을 완료하지 못했습니다.`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function cachedCandidates(keyword, maxRank) {
  const key = normalizeComparable(keyword) + ":" + maxRank;
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
  if (!collection.complete && collection.stopReason !== "naver_result_list_exhausted") return;
  const key = normalizeComparable(keyword) + ":" + maxRank;
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
    const metaTitle = cleanPlaceTitle(await page.locator("meta[property='og:title']").getAttribute("content").catch(() => ""));
    const metaUrl = await page.locator("meta[property='og:url']").getAttribute("content").catch(() => "");
    const canonicalUrl = await page.locator("link[rel='canonical']").getAttribute("href").catch(() => "");
    result.placeIds = uniqueValues([...result.placeIds, ...extractPlaceIds(metaUrl), ...extractPlaceIds(canonicalUrl)]);
    result.placeId = result.placeId || result.placeIds[0] || "";
    const frameTitles = [];
    for (const frame of page.frames()) {
      if (!DETAIL_FRAME_PATTERN.test(frame.url())) continue;
      const title = await frame
        .locator("span.Fc1rA, h1, [class*='place_bluelink'], [class*='GHAhO'], [class*='YouOG']")
        .first()
        .innerText()
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
    const root = document.querySelector("#_pcmap_list_scroll_container") || document.body;
    const rows = Array.from(root.querySelectorAll("li"));
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
      const placeId = String(placeItem?.id || placeItem?.apolloCacheId || "");
      if (placeId && placeItem?.name) {
        return {
          visibleIndex,
          id: placeId,
          text,
          aria: "",
          url: `https://map.naver.com/p/entry/place/${placeId}`,
          hrefs: [],
          html: "",
          isAd: Boolean(placeItem.adId || placeItem.adClickLog || placeItem.adDescription || adLink) || /\b광고\b/.test(text),
          nameNodes: [placeItem.name],
          visitorReviewCount: placeItem.visitorReviewCount || "",
          blogReviewCount: placeItem.blogCafeReviewCount || "",
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
        id: placeId,
        text,
        aria,
        url,
        hrefs,
        html: (row.outerHTML || "").slice(0, 12000),
        isAd: Boolean(adLink) || /\b광고\b/.test(text),
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
    visitorReviewCount: normalizeText(rawRow.visitorReviewCount),
    blogReviewCount: normalizeText(rawRow.blogReviewCount),
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

async function scrollListFrame(frame) {
  return await frame.evaluate(() => {
    const root = document.querySelector("#_pcmap_list_scroll_container");
    if (!root) {
      window.scrollBy(0, Math.max(700, window.innerHeight * 0.85));
      return {
        scrollTop: window.scrollY,
        scrollHeight: document.body.scrollHeight,
        clientHeight: window.innerHeight,
      };
    }
    // The current PC list app appends the remaining organic rows when the
    // scroll container reaches its end. A viewport-sized step made mid-ranked
    // lookups exceed serverless request limits even though no ranks were lost.
    root.scrollTop = root.scrollHeight;
    root.dispatchEvent(new Event("scroll", { bubbles: true }));
    return {
      scrollTop: root.scrollTop,
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    };
  });
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

    for (let attempt = 0; attempt < growthPollAttempts; attempt += 1) {
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
    visitorReviewCount: normalizeText(item?.placeReviewCount || item?.visitorReviewCount),
    blogReviewCount: normalizeText(item?.reviewCount || item?.blogCafeReviewCount),
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
      await page.waitForSelector("#_pcmap_list_scroll_container li", { timeout: DEFAULT_TIMEOUT_MS });
      await scrollListFrame(page);
      await page.waitForTimeout(700);

      const restrictionText = normalizeText(await page.locator("body").innerText().catch(() => ""));
      if (/서비스 이용이 제한되었습니다|과도한 접근 요청/.test(restrictionText)) {
        throw new Error("naver_place_access_limited");
      }

      const candidates = [];
      const visibleRows = await extractVisibleRows(page);
      visibleRows.forEach((row) => appendCandidate(candidates, row));
      const resultLimit = Math.min(maxRank, NAVER_PLACE_MAX_RESULTS);
      const collection = collectionResult(
        candidates,
        resultLimit,
        "single_pass_limit_reached",
        1
      );
      rememberCandidates(keyword, maxRank, collection);
      return collection;
    }

    const initialSearch = await resolveMapSearch(page, keyword);

    const searchCoord = initialSearch.searchCoord;
    await page.goto(buildPlaceListUrl(keyword, maxRank, searchCoord), {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT_MS,
      referer: NAVER_MAP_SEARCH_BASE + encodeURIComponent(keyword),
    });
    await page.waitForSelector("#_pcmap_list_scroll_container li", { timeout: DEFAULT_TIMEOUT_MS });
    await page.waitForTimeout(900);

    const restrictionText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    if (/서비스 이용이 제한되었습니다|과도한 접근 요청/.test(restrictionText)) {
      throw new Error("naver_place_access_limited");
    }

    const resultLimit = Math.min(maxRank, NAVER_PLACE_MAX_RESULTS);
    const collection = await collectRowsProgressively({
      resultLimit,
      maxScrolls: DEFAULT_MAX_SCROLLS,
      deadlineAt,
      readRows: () => extractVisibleRows(page),
      advance: () => scrollListFrame(page),
      wait: (milliseconds) => page.waitForTimeout(milliseconds),
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

export async function lookupNaverPlaceRank(payload = {}) {
  const keyword = normalizeText(payload.keyword);
  const maxRank = clampMaxRank(payload.maxRank || payload.max_rank);
  const placeUrl = normalizeUrl(payload.placeUrl || payload.place_url);
  let placeName = normalizeText(payload.placeName || payload.place_name);
  let placeId = normalizeText(payload.placeId || payload.place_id);

  if (!keyword) {
    return { ok: false, matched: false, message: "keyword_required" };
  }

  const apifyResult = await lookupNaverPlaceRankViaApify(payload);
  if (apifyResult) return apifyResult;

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
      const resolved = placeUrl && !placeId
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
          message: "플레이스 URL에서 ID 또는 상호명을 확인하지 못했습니다.",
          source: "naver_map_browser_collector",
        };
      }

      const target = {
        placeId,
        placeIds,
        placeUrl: resolved.url || placeUrl,
        placeName,
      };
      const collection = await collectCandidatesFromNaverMap(context, keyword, maxRank, collectionDeadlineAt);
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
    return await Promise.race([lookup, timeout]);
  } finally {
    clearTimeout(overallTimeout);
    await browser.close().catch(() => {});
  }
}

function buildCollectionStatus(collection, requestedMaxRank) {
  const checkedCount = Math.min(collection.candidates.length, requestedMaxRank);
  const complete = checkedCount >= requestedMaxRank;
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
  appendCandidate,
  buildCollectionStatus,
  clampMaxRank,
  collectRowsProgressively,
  lookupNaverPlaceRankViaApify,
  normalizeApifyCandidates,
};

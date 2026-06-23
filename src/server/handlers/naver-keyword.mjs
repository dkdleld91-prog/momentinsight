import crypto from "node:crypto";
import { corsHeaders, featureEnabled, isLocalRequest, protectedJson } from "../security.mjs";

const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const DATALAB_BASE_URL = "https://openapi.naver.com";
const DATALAB_HISTORY_START_DATE = "2016-01-01";
const DATALAB_MONTH_LABELS = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];
const DATALAB_AGE_GROUPS = [
  { label: "10대", ages: ["2"] },
  { label: "20대", ages: ["3", "4"] },
  { label: "30대", ages: ["5", "6"] },
  { label: "40대", ages: ["7", "8"] },
  { label: "50대 이상", ages: ["9", "10", "11"] },
];
const DATALAB_GENDER_GROUPS = [
  { key: "female", gender: "f" },
  { key: "male", gender: "m" },
];
const KEYWORD_CACHE_TTL_MS = Number(process.env.MI_KEYWORD_CACHE_TTL_MS || 1000 * 60 * 30);
const KEYWORD_CACHE_MAX = Number(process.env.MI_KEYWORD_CACHE_MAX || 300);
const KEYWORD_RATE_WINDOW_MS = Number(process.env.MI_KEYWORD_RATE_WINDOW_MS || 60_000);
const KEYWORD_RATE_LIMIT = Number(process.env.MI_KEYWORD_RATE_LIMIT || 30);
const keywordCache = new Map();
const keywordRateBucket = new Map();

function config() {
  return {
    searchAdApiKey: process.env.NAVER_SEARCHAD_API_KEY || "",
    searchAdSecretKey: process.env.NAVER_SEARCHAD_SECRET_KEY || "",
    searchAdCustomerId: process.env.NAVER_SEARCHAD_CUSTOMER_ID || "",
    datalabClientId: process.env.NAVER_DATALAB_CLIENT_ID || "",
    datalabClientSecret: process.env.NAVER_DATALAB_CLIENT_SECRET || "",
    openapiClientId: process.env.NAVER_OPENAPI_CLIENT_ID || process.env.NAVER_DATALAB_CLIENT_ID || "",
    openapiClientSecret: process.env.NAVER_OPENAPI_CLIENT_SECRET || process.env.NAVER_DATALAB_CLIENT_SECRET || "",
  };
}

function hasSearchAdConfig(env) {
  return Boolean(env.searchAdApiKey && env.searchAdSecretKey && env.searchAdCustomerId);
}

function hasDatalabConfig(env) {
  return Boolean(env.datalabClientId && env.datalabClientSecret);
}

function hasOpenapiConfig(env) {
  return Boolean(env.openapiClientId && env.openapiClientSecret);
}

function json(request, body, status = 200) {
  return protectedJson(request, body, status);
}

function jsonWithHeaders(request, body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function normalizeKeyword(keyword) {
  return String(keyword || "").replace(/\s+/g, " ").trim();
}

function normalizeCompare(keyword) {
  return normalizeKeyword(keyword).replace(/\s/g, "").toLowerCase();
}

function normalizeSearchAdKeyword(keyword) {
  return normalizeKeyword(keyword).replace(/\s/g, "");
}

function parseNaverNumber(value) {
  if (typeof value === "number") return value;
  if (!value) return 0;
  return Number(String(value).replace(/,/g, "")) || 0;
}

function parseSearchCount(value) {
  if (typeof value === "number") return { value, upperBound: value, isUnderThreshold: false };
  const text = String(value || "").trim();
  if (!text) return { value: 0, upperBound: 0, isUnderThreshold: false };
  if (text.includes("<")) {
    const upperBound = Number(text.replace(/[^\d.]/g, "")) || 10;
    return { value: 0, upperBound, isUnderThreshold: true };
  }
  const parsed = Number(text.replace(/,/g, "")) || 0;
  return { value: parsed, upperBound: parsed, isUnderThreshold: false };
}

function searchVolumeMetric(pcRaw, mobileRaw) {
  const pc = parseSearchCount(pcRaw);
  const mobile = parseSearchCount(mobileRaw);
  const isUnderThreshold = pc.isUnderThreshold || mobile.isUnderThreshold;
  const value = isUnderThreshold ? 0 : pc.value + mobile.value;
  const upperBound = pc.upperBound + mobile.upperBound;
  return {
    pc,
    mobile,
    value,
    upperBound,
    isUnderThreshold,
    label: isUnderThreshold
      ? `${Number(upperBound || 0).toLocaleString("ko-KR")} 미만`
      : Number(value || 0).toLocaleString("ko-KR"),
  };
}

function searchVolumeWithUnit(label) {
  const text = String(label || "확인 필요");
  if (text.includes("미만")) return `${text.replace(/\s*미만$/, "")}회 미만`;
  if (text === "확인 필요") return text;
  return `${text}회`;
}

function keywordAction({ hasExactMatch, isUnderThreshold, volume, comp }) {
  if (!hasExactMatch) return "정확한 월 검색량이 확인되지 않아 연관 키워드를 개별 조회";
  if (isUnderThreshold) return "검색량이 낮아 단독 핵심 키워드보다 보조 키워드로 관리";
  if (volume < 1000) return "검색량이 낮아 롱테일 소재와 SEO 보조 키워드로 관리";
  if (volume < 10000) return comp === "높음"
    ? "검색량은 중간 이하이고 경쟁 지표가 높아 콘텐츠 테스트 중심으로 운영"
    : "검색량과 경쟁도를 함께 보며 보조 키워드 후보로 분류";
  if (comp === "높음") return "검색량은 확인되지만 경쟁 지표가 높아 콘텐츠와 소재를 분리 운영";
  if (comp === "낮음") return "검색량 대비 경쟁 지표가 낮아 SEO와 소재 테스트 후보로 분류";
  return "검색량과 경쟁도를 기준으로 SEO 후보로 분류";
}

function keywordCacheKey(keyword, profileMode) {
  return `${profileMode}:${normalizeCompare(keyword)}`;
}

function getKeywordCache(key) {
  const hit = keywordCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    keywordCache.delete(key);
    return null;
  }
  return {
    payload: hit.payload,
    ttlSeconds: Math.max(0, Math.ceil((hit.expiresAt - Date.now()) / 1000)),
  };
}

function setKeywordCache(key, payload) {
  if (!KEYWORD_CACHE_TTL_MS || KEYWORD_CACHE_TTL_MS < 1) return;
  keywordCache.set(key, {
    payload,
    expiresAt: Date.now() + KEYWORD_CACHE_TTL_MS,
  });
  while (keywordCache.size > KEYWORD_CACHE_MAX) {
    const oldestKey = keywordCache.keys().next().value;
    keywordCache.delete(oldestKey);
  }
}

function clientRateKey(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim() || request.headers.get("x-real-ip") || "anonymous";
}

function checkKeywordRateLimit(request) {
  if (isLocalRequest(request)) return { allowed: true };
  const now = Date.now();
  const key = clientRateKey(request);
  const fresh = (keywordRateBucket.get(key) || []).filter((time) => now - time < KEYWORD_RATE_WINDOW_MS);

  if (fresh.length >= KEYWORD_RATE_LIMIT) {
    keywordRateBucket.set(key, fresh);
    const retryAfter = Math.max(1, Math.ceil((KEYWORD_RATE_WINDOW_MS - (now - fresh[0])) / 1000));
    return { allowed: false, retryAfter };
  }

  fresh.push(now);
  keywordRateBucket.set(key, fresh);

  if (keywordRateBucket.size > 1000) {
    for (const [bucketKey, times] of keywordRateBucket.entries()) {
      const activeTimes = times.filter((time) => now - time < KEYWORD_RATE_WINDOW_MS);
      if (activeTimes.length) keywordRateBucket.set(bucketKey, activeTimes);
      else keywordRateBucket.delete(bucketKey);
    }
  }

  return { allowed: true };
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function compactDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((acc, item) => {
    if (item.type !== "literal") acc[item.type] = item.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function monthsAgo(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

function naverSearchAdHeaders(env, method, path) {
  const timestamp = String(Date.now());
  const message = `${timestamp}.${method}.${path}`;
  const signature = crypto
    .createHmac("sha256", env.searchAdSecretKey)
    .update(message)
    .digest("base64");

  return {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp": timestamp,
    "X-API-KEY": env.searchAdApiKey,
    "X-Customer": String(env.searchAdCustomerId),
    "X-Signature": signature,
  };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15000));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }

    if (!response.ok) {
      const message = payload?.message || payload?.title || payload?.raw || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSearchAdKeyword(env, keyword) {
  const path = "/keywordstool";
  const params = new URLSearchParams({ hintKeywords: normalizeSearchAdKeyword(keyword), showDetail: "1" });
  const payload = await fetchJson(`${SEARCHAD_BASE_URL}${path}?${params.toString()}`, {
    method: "GET",
    headers: naverSearchAdHeaders(env, "GET", path),
  });

  const list = Array.isArray(payload?.keywordList) ? payload.keywordList : [];
  const exact = list.find((item) => normalizeCompare(item.relKeyword) === normalizeCompare(keyword));
  return {
    raw: payload,
    item: exact || null,
    related: list.slice(0, 10),
    hasExactMatch: Boolean(exact),
  };
}

async function fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit = "month", device, gender, ages, timeoutMs }) {
  const body = {
    startDate,
    endDate,
    timeUnit,
    keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
  };
  if (device) body.device = device;
  if (gender) body.gender = gender;
  if (ages?.length) body.ages = ages;

  return fetchJson(`${DATALAB_BASE_URL}/v1/datalab/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Naver-Client-Id": env.datalabClientId,
      "X-Naver-Client-Secret": env.datalabClientSecret,
    },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

async function fetchNaverShoppingSearch(env, keyword) {
  const params = new URLSearchParams({
    query: keyword,
    display: "20",
    start: "1",
    sort: "sim",
  });

  return fetchJson(`${DATALAB_BASE_URL}/v1/search/shop.json?${params.toString()}`, {
    method: "GET",
    headers: {
      "X-Naver-Client-Id": env.openapiClientId,
      "X-Naver-Client-Secret": env.openapiClientSecret,
    },
  });
}

function ratioSum(payload) {
  const data = payload?.results?.[0]?.data || [];
  return data.reduce((sum, item) => sum + Number(item.ratio || 0), 0);
}

function fulfilledValue(result) {
  return result && result.status === "fulfilled" ? result.value : null;
}

function normalizeShares(entries, digits = 1) {
  const total = entries.reduce((sum, item) => sum + Number(item.value || 0), 0);
  if (!total) {
    return entries.map(() => 0);
  }
  const scale = 10 ** digits;
  const target = 100 * scale;
  const rawShares = entries.map((item, index) => {
    const raw = (Number(item.value || 0) / total) * target;
    const floor = Math.floor(raw);
    return { index, floor, rest: raw - floor };
  });
  let remaining = target - rawShares.reduce((sum, item) => sum + item.floor, 0);
  rawShares
    .slice()
    .sort((left, right) => right.rest - left.rest)
    .forEach((item) => {
      if (remaining <= 0) return;
      rawShares[item.index].floor += 1;
      remaining -= 1;
    });

  return rawShares.map((item) => round(item.floor / scale, digits));
}

function formatMonthPeriod(period, isLatest = false) {
  const [, month] = String(period || "").split("-");
  const label = month ? `${month.padStart(2, "0")}월` : String(period || "");
  return isLatest ? `${label}(예상)` : label;
}

function trendData(payload) {
  return payload?.results?.[0]?.data || [];
}

function monthlyShares(payload) {
  const data = trendData(payload);
  if (!data.length) return [];
  return normalizeShares(data.slice(-12).map((item) => ({ value: Number(item.ratio || 0) })));
}

function monthlySeasonalityShares(payload) {
  const data = trendData(payload);
  if (!data.length) return [];
  const sums = Array(12).fill(0);
  data.forEach((item) => {
    const month = Number(String(item.period || "").slice(5, 7));
    if (month >= 1 && month <= 12) sums[month - 1] += Number(item.ratio || 0);
  });
  return normalizeShares(sums.map((value) => ({ value })));
}

function monthlyLabels(payload) {
  const data = trendData(payload).slice(-12);
  return data.map((item, index) => formatMonthPeriod(item.period, index === data.length - 1));
}

function trendLabels(payload) {
  const data = trendData(payload);
  return data.map((item, index) => formatMonthPeriod(item.period, index === data.length - 1));
}

function trendToSeries(trendPayload) {
  const data = trendData(trendPayload);
  if (!data.length) return [];
  return data.map((item) => {
    const ratio = Number(item.ratio || 0);
    return Math.max(0, round(ratio, 1));
  });
}

function estimateMonthlySearchSeries(trendSeries, referenceVolume) {
  const source = Array.isArray(trendSeries) ? trendSeries.map((value) => Number(value || 0)) : [];
  const anchor = Number(referenceVolume || 0);
  if (!source.length || !anchor) return [];
  const latest = source[source.length - 1] || 0;
  const fallback = Math.max(...source, 1);
  const divisor = latest > 0 ? latest : fallback;
  return source.map((value) => Math.max(0, Math.round((value / divisor) * anchor)));
}

function weekdayShares(dailyPayload) {
  const data = dailyPayload?.results?.[0]?.data || [];
  const sums = [0, 0, 0, 0, 0, 0, 0];
  data.forEach((item) => {
    const date = new Date(`${item.period}T00:00:00+09:00`);
    const day = date.getDay();
    sums[day === 0 ? 6 : day - 1] += Number(item.ratio || 0);
  });
  return normalizeShares(sums.map((value) => ({ value })));
}

function shareFromPayloads(payloads) {
  return normalizeShares(payloads.map((payload) => ({ value: ratioSum(payload) })));
}

async function buildDatalabProfile(env, keyword, options = {}) {
  const includeProfile = options.includeProfile !== false;
  const endDate = compactDate(dateDaysAgo(1));
  const trendStartDate = compactDate(monthsAgo(12));
  const ageStartDate = compactDate(monthsAgo(12));

  const trend = await fetchDatalabSearch(env, { keyword, startDate: trendStartDate, endDate, timeUnit: "month" });
  let month = monthlyShares(trend);
  let monthLabels = monthlyLabels(trend);
  let week = [];
  let age = [];
  let gender = null;
  let demographicStatus = includeProfile ? "search_interest_profile" : "trend_only";

  if (includeProfile) {
    const profileRequests = [
      fetchDatalabSearch(env, { keyword, startDate: DATALAB_HISTORY_START_DATE, endDate, timeUnit: "month", timeoutMs: 25000 }),
      fetchDatalabSearch(env, { keyword, startDate: DATALAB_HISTORY_START_DATE, endDate, timeUnit: "date", timeoutMs: 25000 }),
      ...DATALAB_AGE_GROUPS.map((group) => fetchDatalabSearch(env, { keyword, startDate: ageStartDate, endDate, timeUnit: "month", ages: group.ages })),
      ...DATALAB_GENDER_GROUPS.map((group) => fetchDatalabSearch(env, { keyword, startDate: ageStartDate, endDate, timeUnit: "month", gender: group.gender })),
    ];
    const results = await Promise.allSettled(profileRequests);
    const historyMonth = fulfilledValue(results[0]);
    const historyDaily = fulfilledValue(results[1]);
    const agePayloads = results.slice(2, 2 + DATALAB_AGE_GROUPS.length).map(fulfilledValue);
    const genderPayloads = results.slice(2 + DATALAB_AGE_GROUPS.length).map(fulfilledValue);

    if (historyMonth) {
      month = monthlySeasonalityShares(historyMonth);
      monthLabels = DATALAB_MONTH_LABELS;
    }
    week = historyDaily ? weekdayShares(historyDaily) : [];
    if (agePayloads.some(Boolean)) age = shareFromPayloads(agePayloads);
    if (genderPayloads.some(Boolean)) {
      const genderShares = shareFromPayloads(genderPayloads);
      gender = {
        female: genderShares[0] || 0,
        male: genderShares[1] || 0,
      };
    }
    if (!week.length && !age.length && !gender) demographicStatus = "profile_pending";
  }

  return {
    series: trendToSeries(trend),
    seriesLabels: trendLabels(trend),
    month,
    monthLabels,
    trendUnit: "relative_interest_index",
    monthBasis: "2016_current_search_ratio",
    weekBasis: "2016_current_search_ratio",
    ageBasis: "recent_1_year_search_ratio",
    gender,
    age,
    demographicStatus,
    week,
  };
}

function competitionLabel(compIdx) {
  const value = String(compIdx || "");
  if (value === "high" || value.includes("높")) return "높음";
  if (value === "mid" || value.includes("중") || value.includes("보통")) return "보통";
  if (value === "low" || value.includes("낮")) return "낮음";
  return value || "확인 필요";
}

function buildShoppingProfile(payload) {
  if (!payload || typeof payload !== "object") return null;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const prices = items
    .map((item) => parseNaverNumber(item.lprice))
    .filter((price) => price > 0);
  const malls = [...new Set(items.map((item) => String(item.mallName || "").trim()).filter(Boolean))];

  return {
    total: Number(payload.total || 0),
    sampleCount: items.length,
    averagePrice: prices.length ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length) : 0,
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    mallCount: malls.length,
    source: "naver_shopping_search",
  };
}

function buildRelatedKeywordMetrics(searchAd) {
  const seen = new Set();
  return (searchAd?.related || [])
    .map((item) => {
      const keyword = normalizeKeyword(item.relKeyword);
      const key = normalizeCompare(keyword);
      if (!keyword || seen.has(key)) return null;
      seen.add(key);

      const metric = searchVolumeMetric(item.monthlyPcQcCnt, item.monthlyMobileQcCnt);
      const pcVolume = metric.pc.value;
      const mobileVolume = metric.mobile.value;
      const volume = metric.value;
      const comp = competitionLabel(item.compIdx);

      return {
        keyword,
        volume,
        volumeLabel: metric.label,
        volumeUpperBound: metric.upperBound,
        isUnderThreshold: metric.isUnderThreshold,
        pcVolume,
        mobileVolume,
        comp,
        source: searchAd?.hasExactMatch ? "naver_searchad_keyword" : "naver_searchad_related_keyword",
        matchStatus: searchAd?.hasExactMatch ? "exact_context" : "related_only",
      };
    })
    .filter(Boolean);
}

function buildChartData(keyword, searchAd, datalabProfile, shoppingProfile) {
  const item = searchAd?.item || {};
  const hasExactMatch = Boolean(searchAd?.hasExactMatch && searchAd?.item);
  const metric = searchVolumeMetric(item.monthlyPcQcCnt, item.monthlyMobileQcCnt);
  const pcVolume = metric.pc.value;
  const mobileVolume = metric.mobile.value;
  const safeVolume = hasExactMatch ? metric.value : 0;
  const volumeLabel = hasExactMatch ? metric.label : "확인 필요";
  const mobileShare = safeVolume ? Math.round((mobileVolume / safeVolume) * 100) : 0;
  const pcShare = safeVolume ? 100 - mobileShare : 0;
  const comp = hasExactMatch ? competitionLabel(item.compIdx) : "확인 필요";
  const relatedKeywordMetrics = buildRelatedKeywordMetrics(searchAd);
  const trendIndex = datalabProfile?.series?.length ? datalabProfile.series : [];
  const estimatedSeries = estimateMonthlySearchSeries(trendIndex, safeVolume);

  return {
    keyword,
    matchedKeyword: hasExactMatch ? item.relKeyword || keyword : "",
    volumeStatus: hasExactMatch && !metric.isUnderThreshold ? "확인됨" : hasExactMatch ? "범위 확인" : "확인 필요",
    volumeLabel,
    volumeUpperBound: hasExactMatch ? metric.upperBound : 0,
    isUnderThreshold: hasExactMatch ? metric.isUnderThreshold : false,
    trendStatus: datalabProfile?.series?.length ? "확인됨" : "수집 대기",
    volume: safeVolume,
    comp,
    action: keywordAction({ hasExactMatch, isUnderThreshold: metric.isUnderThreshold, volume: safeVolume, comp }),
    insight: hasExactMatch
      ? `월 검색량 ${searchVolumeWithUnit(volumeLabel)}, 경쟁 지표 ${comp}입니다.`
      : "정확한 월 검색량이 확인되지 않았습니다. 연관 키워드를 개별 조회해주세요.",
    series: estimatedSeries,
    seriesLabels: datalabProfile?.seriesLabels || [],
    trendIndex,
    trendUnit: estimatedSeries.length ? "monthly_search_volume_estimate" : datalabProfile?.trendUnit || "",
    month: datalabProfile?.month || [],
    monthLabels: datalabProfile?.monthLabels || [],
    monthBasis: datalabProfile?.monthBasis || "",
    device: { mobile: mobileShare, pc: pcShare },
    gender: datalabProfile?.gender || null,
    age: datalabProfile?.age || [],
    ageBasis: datalabProfile?.ageBasis || "",
    demographicStatus: datalabProfile?.demographicStatus || "",
    week: datalabProfile?.week || [],
    weekBasis: datalabProfile?.weekBasis || "",
    naver: {
      monthlyPcQcCnt: item.monthlyPcQcCnt || "0",
      monthlyMobileQcCnt: item.monthlyMobileQcCnt || "0",
      monthlyAvePcClkCnt: item.monthlyAvePcClkCnt || "0",
      monthlyAveMobileClkCnt: item.monthlyAveMobileClkCnt || "0",
      monthlyAvePcCtr: item.monthlyAvePcCtr || "0",
      monthlyAveMobileCtr: item.monthlyAveMobileCtr || "0",
      relatedKeywords: relatedKeywordMetrics.map((related) => related.keyword),
      relatedKeywordMetrics,
    },
    shopping: shoppingProfile,
  };
}

function buildSourceStatus({ env, searchAd, datalabProfile, datalabError, shoppingProfile, shoppingError, includeProfile }) {
  const datalabConfigured = hasDatalabConfig(env);
  const shoppingConfigured = hasOpenapiConfig(env);
  const ratioReady = Boolean(datalabProfile?.month?.length && datalabProfile?.week?.length);
  const profileReady = !includeProfile || datalabProfile?.demographicStatus === "search_interest_profile";

  return {
    searchVolume: searchAd?.hasExactMatch
      ? { status: "ok", label: "월 검색량 확인" }
      : { status: "partial", label: "정확 키워드 미일치", relatedCount: searchAd?.related?.length || 0 },
    trend: !datalabConfigured
      ? { status: "not_configured", label: "검색 추이 미연결" }
      : datalabError
        ? { status: "error", label: "검색 추이 확인 실패" }
        : datalabProfile?.series?.length
          ? { status: "ok", label: "검색 추이 확인" }
          : { status: "pending", label: "검색 추이 대기" },
    ratios: !datalabConfigured
      ? { status: "not_configured", label: "검색 비율 미연결" }
      : datalabError
        ? { status: "error", label: "검색 비율 확인 실패" }
        : ratioReady && profileReady
          ? { status: "ok", label: "검색 비율 확인" }
          : { status: "partial", label: "일부 검색 비율 대기" },
    shopping: !shoppingConfigured
      ? { status: "not_configured", label: "쇼핑 참고 지표 미연결" }
      : shoppingError
        ? { status: "error", label: "쇼핑 참고 지표 확인 실패" }
        : shoppingProfile
          ? { status: "ok", label: "쇼핑 참고 지표 확인" }
          : { status: "pending", label: "쇼핑 참고 지표 대기" },
  };
}

function sourceUserMessage(status) {
  if (status.searchVolume.status === "partial") {
    return "정확히 일치하는 월 검색량이 없어 연관 키워드를 참고로 표시합니다.";
  }
  if (status.trend.status === "ok" && status.ratios.status === "ok") {
    return "월 검색량과 검색 비율이 확인되었습니다.";
  }
  return "월 검색량은 확인됐고 일부 참고 지표는 확인 대기입니다.";
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (request.method !== "GET") return json(request, { ok: false, message: "Method not allowed" }, 405);

    if (!featureEnabled(request, "MI_KEYWORD_API_ENABLED")) {
      return json(request, {
        ok: false,
        message: "키워드 데이터 조회는 현재 준비 중입니다.",
      }, 403);
    }

    const url = new URL(request.url);
    const keyword = normalizeKeyword(url.searchParams.get("keyword"));
    if (!keyword) return json(request, { ok: false, message: "검색어를 입력해주세요." }, 400);
    const profileMode = String(url.searchParams.get("profile") || "full").toLowerCase();
    const includeProfile = profileMode !== "compare" && profileMode !== "trend";

    const env = config();
    if (!hasSearchAdConfig(env)) {
      return json(request, {
        ok: false,
        message: "키워드 데이터 연결이 준비되지 않았습니다. 관리자에게 문의해주세요.",
      }, 503);
    }

    const cacheKey = keywordCacheKey(keyword, profileMode);
    const cached = getKeywordCache(cacheKey);
    if (cached) {
      return json(request, {
        ...cached.payload,
        cache: { hit: true, ttlSeconds: cached.ttlSeconds },
      });
    }

    const rate = checkKeywordRateLimit(request);
    if (!rate.allowed) {
      return jsonWithHeaders(request, {
        ok: false,
        code: "KEYWORD_RATE_LIMITED",
        message: "조회 요청이 많습니다. 잠시 후 다시 시도해주세요.",
        retryAfter: rate.retryAfter,
      }, 429, { "retry-after": String(rate.retryAfter) });
    }

    try {
      const searchAd = await fetchSearchAdKeyword(env, keyword);
      let datalabProfile = null;
      let datalabError = null;
      let shoppingProfile = null;
      let shoppingError = null;

      if (hasDatalabConfig(env)) {
        try {
          datalabProfile = await buildDatalabProfile(env, keyword, { includeProfile });
        } catch (error) {
          datalabError = error.message;
        }
      }

      if (hasOpenapiConfig(env)) {
        try {
          shoppingProfile = buildShoppingProfile(await fetchNaverShoppingSearch(env, keyword));
        } catch (error) {
          shoppingError = error.message;
        }
      }

      const warnings = [];
      if (!searchAd.hasExactMatch) warnings.push("exact_keyword_not_found");
      if (datalabError) warnings.push("trend_unavailable");
      if (shoppingError) warnings.push("shopping_unavailable");

      const sourceStatus = buildSourceStatus({
        env,
        searchAd,
        datalabProfile,
        datalabError,
        shoppingProfile,
        shoppingError,
        includeProfile,
      });
      const payload = {
        ok: true,
        source: {
          searchVolume: searchAd.hasExactMatch ? "naver_searchad_exact" : "naver_searchad_related_only",
          trend: sourceStatus.trend.status === "ok" ? "naver_datalab_relative_ratio" : sourceStatus.trend.status,
          profile: datalabProfile ? (includeProfile ? datalabProfile.demographicStatus : "trend_only") : sourceStatus.ratios.status,
          shopping: shoppingProfile ? "naver_shopping_search" : sourceStatus.shopping.status,
        },
        sourceStatus,
        userMessage: sourceUserMessage(sourceStatus),
        warnings,
        chartData: buildChartData(keyword, searchAd, datalabProfile, shoppingProfile),
        cache: { hit: false, ttlSeconds: Math.ceil(KEYWORD_CACHE_TTL_MS / 1000) },
      };

      setKeywordCache(cacheKey, payload);
      return json(request, payload);
    } catch (error) {
      return json(request, {
        ok: false,
        message: "키워드 데이터 조회 중 오류가 발생했습니다.",
      }, error.status || 500);
    }
  },
};

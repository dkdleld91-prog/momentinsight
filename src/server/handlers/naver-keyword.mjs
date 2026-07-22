import crypto from "node:crypto";
import { corsHeaders, featureEnabled, isLocalRequest, protectedJson } from "../security.mjs";
import {
  hasNaverMigratedApiConfig,
  naverApiErrorMessage,
  naverApiProviderConfig,
  naverDatalabRequest,
  resolveNaverApiTransport,
} from "../naver-api-hub.mjs";

const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const NAVER_LEGACY_OPENAPI_BASE_URL = "https://openapi.naver.com";
const DATALAB_HISTORY_START_DATE = "2016-01-01";
const SHOPPING_INSIGHT_START_DATE = "2017-08-01";
const KEYWORD_TREND_MONTHS = 36;
const DATALAB_MONTH_LABELS = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];
const SHOPPING_MAIN_CATEGORY_IDS = {
  "패션의류": "50000000",
  "패션잡화": "50000001",
  "화장품/미용": "50000002",
  "디지털/가전": "50000003",
  "가구/인테리어": "50000004",
  "출산/육아": "50000005",
  "식품": "50000006",
  "스포츠/레저": "50000007",
  "생활/건강": "50000008",
  "여가/생활편의": "50000009",
};
const SHOPPING_DEVICE_GROUPS = ["mo", "pc"];
const SHOPPING_GENDER_GROUPS = ["f", "m"];
const SHOPPING_AGE_GROUPS = ["10", "20", "30", "40", "50", "60"];
const KEYWORD_CACHE_TTL_MS = Number(process.env.MI_KEYWORD_CACHE_TTL_MS || 1000 * 60 * 30);
const KEYWORD_CACHE_MAX = Number(process.env.MI_KEYWORD_CACHE_MAX || 300);
const KEYWORD_RATE_WINDOW_MS = Number(process.env.MI_KEYWORD_RATE_WINDOW_MS || 60_000);
const KEYWORD_RATE_LIMIT = Number(process.env.MI_KEYWORD_RATE_LIMIT || 30);
const keywordCache = new Map();
const keywordRateBucket = new Map();

function config() {
  const datalabClientId = process.env.NAVER_DATALAB_CLIENT_ID || process.env.NAVER_OPENAPI_CLIENT_ID || "";
  const datalabClientSecret = process.env.NAVER_DATALAB_CLIENT_SECRET || process.env.NAVER_OPENAPI_CLIENT_SECRET || "";
  const openapiClientId = process.env.NAVER_OPENAPI_CLIENT_ID || process.env.NAVER_DATALAB_CLIENT_ID || "";
  const openapiClientSecret = process.env.NAVER_OPENAPI_CLIENT_SECRET || process.env.NAVER_DATALAB_CLIENT_SECRET || "";

  return {
    searchAdApiKey: process.env.NAVER_SEARCHAD_API_KEY || "",
    searchAdSecretKey: process.env.NAVER_SEARCHAD_SECRET_KEY || "",
    searchAdCustomerId: process.env.NAVER_SEARCHAD_CUSTOMER_ID || "",
    datalabClientId,
    datalabClientSecret,
    openapiClientId,
    openapiClientSecret,
    naverApi: naverApiProviderConfig(),
  };
}

function hasSearchAdConfig(env) {
  return Boolean(env.searchAdApiKey && env.searchAdSecretKey && env.searchAdCustomerId);
}

function hasDatalabConfig(env) {
  return hasNaverMigratedApiConfig(env.naverApi, "datalab");
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

function keywordConfigSignature(env) {
  const hashConfigPart = (value) => crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 10);

  const datalabProvider = resolveNaverApiTransport(env.naverApi, "datalab");
  const datalabClientId = datalabProvider === "hub"
    ? env.naverApi?.hub?.clientId
    : env.naverApi?.legacy?.datalabClientId;

  return [
    hasSearchAdConfig(env) ? `searchad:${hashConfigPart(`${env.searchAdApiKey}:${env.searchAdCustomerId}`)}` : "no-searchad",
    hasDatalabConfig(env) ? `datalab:${datalabProvider}:${hashConfigPart(datalabClientId)}` : "no-datalab",
    hasOpenapiConfig(env) ? "openapi" : "no-openapi",
  ].join(":");
}

function keywordCacheKey(keyword, profileMode, env) {
  return `${profileMode}:${keywordConfigSignature(env)}:${normalizeCompare(keyword)}`;
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

function canCacheKeywordPayload(payload) {
  const statuses = Object.values(payload?.sourceStatus || {}).map((item) => item?.status);
  return statuses.length > 0 && statuses.every((status) => status === "ok");
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const retries = Number(options.retries || 0);
  const retryDelayMs = Number(options.retryDelayMs || 350);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
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
        const message = naverApiErrorMessage(payload, `HTTP ${response.status}`);
        const error = new Error(message);
        error.status = response.status;
        error.code = payload?.errorCode || "";
        error.payload = payload;
        const retryAfterSeconds = Number(response.headers.get("retry-after") || 0);
        error.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? Math.min(2_000, retryAfterSeconds * 1_000)
          : 0;
        throw error;
      }

      return payload;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const networkFailure = error instanceof TypeError && status === 0;
      const transient = error?.name === "AbortError"
        || networkFailure
        || status === 408
        || status === 425
        || status === 429
        || status >= 500;
      if (!transient || attempt >= retries) throw error;
      const waitMs = Math.min(2_000, Math.max(
        retryDelayMs * (attempt + 1),
        Number(error?.retryAfterMs || 0),
      ));
      await delay(waitMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
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

  const request = naverDatalabRequest(env.naverApi, "search-trend");
  return fetchJson(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body),
    timeoutMs,
    retries: request.provider === "hub" ? 1 : 0,
    retryDelayMs: 350,
  });
}

async function fetchShoppingInsightKeyword(env, endpoint, { keyword, category, startDate, endDate, timeUnit = "month", device = "", gender = "", ages = [], timeoutMs }) {
  const body = {
    startDate,
    endDate,
    timeUnit,
    category,
    keyword,
    device,
    gender,
    ages,
  };

  const request = naverDatalabRequest(env.naverApi, "shopping-insight-keyword", endpoint);
  return fetchJson(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body),
    timeoutMs,
    retries: request.provider === "hub" ? 1 : 0,
    retryDelayMs: 350,
  });
}

async function fetchNaverShoppingSearch(env, keyword) {
  const params = new URLSearchParams({
    query: keyword,
    display: "20",
    start: "1",
    sort: "sim",
  });

  return fetchJson(`${NAVER_LEGACY_OPENAPI_BASE_URL}/v1/search/shop.json?${params.toString()}`, {
    method: "GET",
    headers: {
      "X-Naver-Client-Id": env.openapiClientId,
      "X-Naver-Client-Secret": env.openapiClientSecret,
    },
  });
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

function parsePeriodParts(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: match[3] ? Number(match[3]) : 1,
  };
}

function lastDayOfMonth(year, month) {
  if (!year || !month) return 31;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isPartialMonthPeriod(period, endDate) {
  const periodParts = parsePeriodParts(period);
  const endParts = parsePeriodParts(endDate);
  if (!periodParts || !endParts) return false;
  if (periodParts.year !== endParts.year || periodParts.month !== endParts.month) return false;
  return endParts.day < lastDayOfMonth(endParts.year, endParts.month);
}

function formatMonthPeriod(period, isEstimated = false) {
  const [, month] = String(period || "").split("-");
  const label = month ? `${month.padStart(2, "0")}월` : String(period || "");
  return isEstimated ? `${label}(예상)` : label;
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

function monthlyLabels(payload, endDate = "") {
  const data = trendData(payload).slice(-12);
  return data.map((item) => formatMonthPeriod(item.period, isPartialMonthPeriod(item.period, endDate)));
}

export function trendLabels(payload, endDate = "") {
  const data = trendData(payload);
  return data.map((item) => formatMonthPeriod(item.period, isPartialMonthPeriod(item.period, endDate)));
}

function trendPeriods(payload) {
  return trendData(payload).map((item) => String(item.period || ""));
}

function trendToSeries(trendPayload) {
  const data = trendData(trendPayload);
  if (!data.length) return [];
  return data.map((item) => {
    const ratio = Number(item.ratio || 0);
    return Math.max(0, round(ratio, 1));
  });
}

export function latestCompleteTrendIndex(trendPayload, endDate = "") {
  const data = trendData(trendPayload);
  for (let index = data.length - 1; index >= 0; index -= 1) {
    if (isPartialMonthPeriod(data[index]?.period, endDate)) continue;
    if (Number(data[index]?.ratio || 0) > 0) return index;
  }
  return -1;
}

export function estimateMonthlySearchSeries(trendSeries, referenceVolume, anchorIndex = -1) {
  const source = Array.isArray(trendSeries) ? trendSeries.map((value) => Number(value || 0)) : [];
  const anchor = Number(referenceVolume || 0);
  if (!source.length || !anchor) return [];
  const index = Number.isInteger(anchorIndex) ? anchorIndex : -1;
  const anchorRatio = index >= 0 && index < source.length ? source[index] : 0;
  const fallback = source.reduce((max, value) => (value > max ? value : max), 0) || 1;
  const divisor = anchorRatio > 0 ? anchorRatio : fallback;
  return source.map((value) => Math.max(0, Math.round((value / divisor) * anchor)));
}

function weekdayShares(dailyPayload) {
  const data = dailyPayload?.results?.[0]?.data || [];
  const sums = [0, 0, 0, 0, 0, 0, 0];
  data.forEach((item) => {
    const [year, month, dayOfMonth] = String(item.period || "").split("-").map(Number);
    if (!year || !month || !dayOfMonth) return;
    const day = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay();
    sums[day === 0 ? 6 : day - 1] += Number(item.ratio || 0);
  });
  return normalizeShares(sums.map((value) => ({ value })));
}

function groupedRatioSums(payload, allowedGroups) {
  const allowed = new Set(allowedGroups);
  const sums = Object.fromEntries(allowedGroups.map((group) => [group, 0]));
  const seen = new Set();
  const data = payload?.results?.[0]?.data || [];
  data.forEach((item) => {
    const group = String(item.group || "");
    if (!allowed.has(group)) return;
    sums[group] += Number(item.ratio || 0);
    seen.add(group);
  });
  return { sums, seen };
}

function groupedShares(payload, groups) {
  const { sums, seen } = groupedRatioSums(payload, groups);
  if (!groups.every((group) => seen.has(group))) return null;
  return normalizeShares(groups.map((group) => ({ value: sums[group] })));
}

export function shoppingAgeProfile(payload, endDate = "") {
  const periods = new Map();
  const data = payload?.results?.[0]?.data || [];

  data.forEach((item) => {
    const period = String(item.period || "");
    const group = String(item.group || "");
    const ratio = Number(item.ratio || 0);
    if (!period || !SHOPPING_AGE_GROUPS.includes(group) || !Number.isFinite(ratio) || ratio < 0) return;
    if (!periods.has(period)) {
      periods.set(period, Object.fromEntries(SHOPPING_AGE_GROUPS.map((ageGroup) => [ageGroup, 0])));
    }
    periods.get(period)[group] += ratio;
  });

  const period = [...periods.keys()]
    .filter((candidate) => !isPartialMonthPeriod(candidate, endDate))
    .sort()
    .reverse()
    .find((candidate) => Object.values(periods.get(candidate)).some((value) => value > 0));
  if (!period) return null;

  const sums = periods.get(period);
  const buckets = [
    sums["10"],
    sums["20"],
    sums["30"],
    sums["40"],
    sums["50"] + sums["60"],
  ];
  return {
    period,
    shares: normalizeShares(buckets.map((value) => ({ value }))),
  };
}

function shoppingCategoryIdFromName(categoryName) {
  return SHOPPING_MAIN_CATEGORY_IDS[String(categoryName || "").trim()] || "";
}

function dominantShoppingCategory(items) {
  const counts = new Map();
  items.forEach((item) => {
    const category = String(item.category1 || "").trim();
    if (!category) return;
    counts.set(category, (counts.get(category) || 0) + 1);
  });
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
}

async function allSettledInBatches(tasks, size = 2, gapMs = 120) {
  const results = [];
  for (let index = 0; index < tasks.length; index += size) {
    const batch = tasks.slice(index, index + size).map((task) => task());
    results.push(...await Promise.allSettled(batch));
    if (index + size < tasks.length) await delay(gapMs);
  }
  return results;
}

async function buildDatalabProfile(env, keyword, options = {}) {
  const includeProfile = options.includeProfile !== false;
  const endDate = compactDate(dateDaysAgo(1));
  const trendStartDate = compactDate(monthsAgo(KEYWORD_TREND_MONTHS));
  const ageStartDate = compactDate(monthsAgo(12));
  const shoppingCategoryId = options.shoppingCategoryId || "";
  const shoppingStartDate = ageStartDate < SHOPPING_INSIGHT_START_DATE ? SHOPPING_INSIGHT_START_DATE : ageStartDate;

  const trend = await fetchDatalabSearch(env, { keyword, startDate: trendStartDate, endDate, timeUnit: "month" });
  let month = monthlyShares(trend);
  let monthLabels = monthlyLabels(trend, endDate);
  let monthBasis = "recent_12_month_trend_ratio";
  let week = [];
  let age = [];
  let agePeriod = "";
  let device = null;
  let gender = null;
  let demographicStatus = includeProfile ? "search_interest_profile" : "trend_only";
  const profileStatus = {};

  if (includeProfile) {
    const profileRequests = [
      () => fetchDatalabSearch(env, { keyword, startDate: DATALAB_HISTORY_START_DATE, endDate, timeUnit: "month", timeoutMs: 25000 }),
      () => fetchDatalabSearch(env, { keyword, startDate: DATALAB_HISTORY_START_DATE, endDate, timeUnit: "date", timeoutMs: 25000 }),
      ...(shoppingCategoryId ? [
        () => fetchShoppingInsightKeyword(env, "device", { keyword, category: shoppingCategoryId, startDate: shoppingStartDate, endDate, timeUnit: "month", timeoutMs: 15000 }),
        () => fetchShoppingInsightKeyword(env, "gender", { keyword, category: shoppingCategoryId, startDate: shoppingStartDate, endDate, timeUnit: "month", timeoutMs: 15000 }),
        () => fetchShoppingInsightKeyword(env, "age", { keyword, category: shoppingCategoryId, startDate: shoppingStartDate, endDate, timeUnit: "month", timeoutMs: 15000 }),
      ] : []),
    ];
    const results = await allSettledInBatches(profileRequests, 2, 150);
    const historyMonth = fulfilledValue(results[0]);
    const historyDaily = fulfilledValue(results[1]);
    const devicePayload = shoppingCategoryId ? fulfilledValue(results[2]) : null;
    const genderPayload = shoppingCategoryId ? fulfilledValue(results[3]) : null;
    const agePayload = shoppingCategoryId ? fulfilledValue(results[4]) : null;

    if (historyMonth) {
      month = monthlySeasonalityShares(historyMonth);
      monthLabels = DATALAB_MONTH_LABELS;
      monthBasis = "2016_current_search_ratio";
    }
    week = historyDaily ? weekdayShares(historyDaily) : [];
    if (devicePayload) {
      const deviceShares = groupedShares(devicePayload, SHOPPING_DEVICE_GROUPS);
      if (deviceShares) {
        device = {
          mobile: deviceShares[0] || 0,
          pc: deviceShares[1] || 0,
        };
      }
    }
    if (genderPayload) {
      const genderShares = groupedShares(genderPayload, SHOPPING_GENDER_GROUPS);
      if (genderShares) {
        gender = {
          female: genderShares[0] || 0,
          male: genderShares[1] || 0,
        };
      }
    }
    if (agePayload) {
      const ageProfile = shoppingAgeProfile(agePayload, endDate);
      if (ageProfile) {
        age = ageProfile.shares;
        agePeriod = ageProfile.period;
      }
    }

    profileStatus.month = historyMonth ? "ok" : "partial";
    profileStatus.week = historyDaily ? "ok" : "partial";
    profileStatus.device = device ? "ok" : shoppingCategoryId ? "partial" : "category_required";
    profileStatus.gender = gender ? "ok" : shoppingCategoryId ? "partial" : "category_required";
    profileStatus.age = age.length ? "ok" : shoppingCategoryId ? "partial" : "category_required";

    if (week.length && age.length && gender) {
      demographicStatus = "shopping_keyword_profile";
    } else if (week.length || age.length || gender || device) {
      demographicStatus = "profile_partial";
    } else {
      demographicStatus = "profile_pending";
    }
  }

  return {
    series: trendToSeries(trend),
    seriesLabels: trendLabels(trend, endDate),
    seriesPeriods: trendPeriods(trend),
    seriesAnchorIndex: latestCompleteTrendIndex(trend, endDate),
    month,
    monthLabels,
    trendUnit: "relative_interest_index",
    monthBasis,
    weekBasis: "2016_current_search_ratio",
    ageBasis: shoppingCategoryId ? "latest_complete_month_shopping_keyword_share" : "",
    agePeriod,
    device,
    deviceBasis: shoppingCategoryId ? "recent_1_year_shopping_keyword_ratio" : "",
    gender,
    genderBasis: shoppingCategoryId ? "recent_1_year_shopping_keyword_ratio" : "",
    age,
    demographicStatus,
    profileStatus,
    shoppingCategoryId,
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

function keywordMarketLabel(score) {
  if (!Number.isFinite(score)) return "확인 필요";
  if (score >= 75) return "매우 높음";
  if (score >= 55) return "높음";
  if (score >= 35) return "보통";
  return "낮음";
}

function boundedMarketScore(value, minimum = 0) {
  if (!Number.isFinite(value)) return null;
  return Math.min(100, Math.max(minimum, Math.round(value)));
}

function absoluteShoppingSupplyScore(shoppingTotal) {
  if (!Number.isFinite(shoppingTotal) || shoppingTotal <= 0) return null;
  // About 10,000 products is the lower catalogue-saturation boundary and
  // 300,000 products is treated as fully saturated. A logarithmic scale keeps
  // the gap between niche and representative categories meaningful.
  return boundedMarketScore(((Math.log10(shoppingTotal) - 4) / 1.5) * 100, 1);
}

export function keywordMarketIndicators({
  volume = 0,
  isUnderThreshold = false,
  competition = "",
  shoppingTotal = 0,
} = {}) {
  const exactVolume = Number(volume);
  const exactShoppingTotal = Number(shoppingTotal);
  const hasVolume = !isUnderThreshold && Number.isFinite(exactVolume) && exactVolume > 0;
  const hasShoppingTotal = Number.isFinite(exactShoppingTotal) && exactShoppingTotal > 0;
  const demandScore = hasVolume
    ? Math.min(100, Math.max(1, Math.round((Math.log10(exactVolume + 1) / 5) * 100)))
    : null;

  const competitionText = competitionLabel(competition);
  const adCompetitionScore = competitionText === "높음"
    ? 84
    : competitionText === "보통"
      ? 56
      : competitionText === "낮음"
        ? 28
        : null;
  const absoluteSupplyScore = hasShoppingTotal
    ? absoluteShoppingSupplyScore(exactShoppingTotal)
    : null;
  const comparableVolume = hasVolume ? exactVolume : isUnderThreshold ? 10 : null;
  const relativeSupplyScore = Number.isFinite(comparableVolume) && comparableVolume > 0 && hasShoppingTotal
    ? boundedMarketScore(Math.log10(1 + (exactShoppingTotal / comparableVolume)) * 50, 1)
    : null;
  const demandSupplyScaleScore = Number.isFinite(demandScore) && Number.isFinite(absoluteSupplyScore)
    ? boundedMarketScore((demandScore * absoluteSupplyScore) / 100, 1)
    : null;
  const supplyCompetitionScore = [demandSupplyScaleScore, relativeSupplyScore]
    .filter(Number.isFinite)
    .reduce((highest, score) => Math.max(highest, score), -Infinity);
  const hasSupplyCompetitionScore = Number.isFinite(supplyCompetitionScore);

  let competitionScore = null;
  if (Number.isFinite(adCompetitionScore) && hasSupplyCompetitionScore) {
    competitionScore = boundedMarketScore((adCompetitionScore * 0.35) + (supplyCompetitionScore * 0.65));
  } else if (Number.isFinite(adCompetitionScore)) {
    competitionScore = adCompetitionScore;
  } else if (hasSupplyCompetitionScore) {
    competitionScore = supplyCompetitionScore;
  }

  const salesOpportunityScore = Number.isFinite(demandScore) && Number.isFinite(competitionScore)
    ? Math.min(100, Math.max(0, Math.round((demandScore * 0.65) + ((100 - competitionScore) * 0.35))))
    : null;

  const demand = { score: demandScore, label: keywordMarketLabel(demandScore) };
  const marketCompetition = { score: competitionScore, label: keywordMarketLabel(competitionScore) };
  const salesOpportunity = { score: salesOpportunityScore, label: keywordMarketLabel(salesOpportunityScore) };
  let action = "검색수요와 상품 공급을 함께 확인한 뒤 SEO 후보로 분류";
  if (Number.isFinite(competitionScore) && competitionScore >= 75 && Number.isFinite(demandScore) && demandScore >= 75) {
    action = "대표 포화 키워드 · 세부 고효율 키워드 병행 검토";
  } else if (Number.isFinite(salesOpportunityScore) && salesOpportunityScore >= 75 && Number.isFinite(competitionScore) && competitionScore < 55) {
    action = "수요 대비 상품 공급이 적은 SEO 우선 후보";
  } else if (Number.isFinite(competitionScore) && competitionScore >= 75) {
    action = "상품 등록 경쟁이 높아 세부 키워드 확장 검토";
  } else if (Number.isFinite(salesOpportunityScore) && salesOpportunityScore >= 55) {
    action = "수요·공급 균형이 좋은 SEO 후보";
  }

  const insightFacts = [];
  if (hasVolume) insightFacts.push(`월 검색량 ${Number(exactVolume).toLocaleString("ko-KR")}회`);
  if (hasShoppingTotal) insightFacts.push(`쇼핑 상품수 ${Number(exactShoppingTotal).toLocaleString("ko-KR")}개`);
  const insight = insightFacts.length && Number.isFinite(competitionScore)
    ? `${insightFacts.join(", ")}이며 종합 경쟁강도는 ${marketCompetition.label}으로 확인됩니다.`
    : insightFacts.length
      ? `${insightFacts.join(", ")}입니다.`
      : Number.isFinite(competitionScore)
        ? `종합 경쟁강도는 ${marketCompetition.label}으로 확인됩니다.`
        : "검색수요와 상품 공급을 확인한 뒤 종합 경쟁강도를 표시합니다.";

  return {
    demand,
    competition: marketCompetition,
    salesOpportunity,
    action,
    insight,
    basis: "검색수요×상품규모·수요 대비 상품밀도·검색광고 경쟁도 기반 참고 지표",
    disclaimer: "판매 기회율은 실제 매출 전환율이 아닙니다.",
  };
}

function buildShoppingProfile(payload) {
  if (!payload || typeof payload !== "object") return null;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const prices = items
    .map((item) => parseNaverNumber(item.lprice))
    .filter((price) => price > 0);
  const malls = [...new Set(items.map((item) => String(item.mallName || "").trim()).filter(Boolean))];
  const dominantCategory = dominantShoppingCategory(items);
  const dominantCategoryId = shoppingCategoryIdFromName(dominantCategory);

  return {
    total: Number(payload.total || 0),
    sampleCount: items.length,
    averagePrice: prices.length ? Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length) : 0,
    minPrice: prices.length ? Math.min(...prices) : 0,
    maxPrice: prices.length ? Math.max(...prices) : 0,
    mallCount: malls.length,
    category1: dominantCategory,
    categoryId: dominantCategoryId,
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
  const deviceShare = datalabProfile?.device || { mobile: mobileShare, pc: pcShare };
  const comp = hasExactMatch ? competitionLabel(item.compIdx) : "확인 필요";
  const relatedKeywordMetrics = buildRelatedKeywordMetrics(searchAd);
  const trendIndex = datalabProfile?.series?.length ? datalabProfile.series : [];
  const estimatedSeries = estimateMonthlySearchSeries(trendIndex, safeVolume, datalabProfile?.seriesAnchorIndex);

  return {
    keyword,
    matchedKeyword: hasExactMatch ? item.relKeyword || keyword : "",
    volumeStatus: hasExactMatch && !metric.isUnderThreshold ? "확인됨" : hasExactMatch ? "범위 확인" : "확인 필요",
    volumeLabel,
    volumeUpperBound: hasExactMatch ? metric.upperBound : 0,
    isUnderThreshold: hasExactMatch ? metric.isUnderThreshold : false,
    trendStatus: datalabProfile?.series?.length ? "확인됨" : "연결 후 표시",
    volume: safeVolume,
    comp,
    action: keywordAction({ hasExactMatch, isUnderThreshold: metric.isUnderThreshold, volume: safeVolume, comp }),
    insight: hasExactMatch
      ? `월 검색량 ${searchVolumeWithUnit(volumeLabel)}, 경쟁 지표 ${comp}입니다.`
      : "정확한 월 검색량이 확인되지 않았습니다. 연관 키워드를 개별 조회해주세요.",
    series: estimatedSeries,
    seriesLabels: datalabProfile?.seriesLabels || [],
    seriesPeriods: datalabProfile?.seriesPeriods || [],
    trendIndex,
    trendUnit: estimatedSeries.length ? "monthly_search_volume_estimate" : datalabProfile?.trendUnit || "",
    month: datalabProfile?.month || [],
    monthLabels: datalabProfile?.monthLabels || [],
    monthBasis: datalabProfile?.monthBasis || "",
    device: deviceShare,
    deviceBasis: datalabProfile?.deviceBasis || "naver_searchad_monthly_query_count",
    gender: datalabProfile?.gender || null,
    genderBasis: datalabProfile?.genderBasis || "",
    age: datalabProfile?.age || [],
    ageBasis: datalabProfile?.ageBasis || "",
    agePeriod: datalabProfile?.agePeriod || "",
    demographicStatus: datalabProfile?.demographicStatus || "",
    profileStatus: datalabProfile?.profileStatus || {},
    shoppingCategoryId: datalabProfile?.shoppingCategoryId || shoppingProfile?.categoryId || "",
    shoppingCategoryName: shoppingProfile?.category1 || "",
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
    market: keywordMarketIndicators({
      volume: safeVolume,
      isUnderThreshold: hasExactMatch ? metric.isUnderThreshold : false,
      competition: comp,
      shoppingTotal: shoppingProfile?.total || 0,
    }),
  };
}

function buildSourceStatus({ env, searchAd, datalabProfile, datalabError, shoppingProfile, shoppingError, includeProfile }) {
  const datalabConfigured = hasDatalabConfig(env);
  const shoppingConfigured = hasOpenapiConfig(env);
  const ratioReady = Boolean(datalabProfile?.month?.length && datalabProfile?.week?.length);
  const profileReady = !includeProfile || ["search_interest_profile", "shopping_keyword_profile"].includes(datalabProfile?.demographicStatus);
  const profilePartial = includeProfile && datalabProfile?.demographicStatus === "profile_partial";
  const datalabErrorLabel = String(datalabError || "").includes("Query limit exceeded")
    ? "DataLab 한도 초과"
    : "검색 비율 확인 실패";
  const trendErrorLabel = String(datalabError || "").includes("Query limit exceeded")
    ? "DataLab 한도 초과"
    : "검색 추이 확인 실패";

  return {
    searchVolume: searchAd?.hasExactMatch
      ? { status: "ok", label: "월 검색량 확인" }
      : { status: "partial", label: "정확 키워드 미일치", relatedCount: searchAd?.related?.length || 0 },
    trend: !datalabConfigured
      ? { status: "not_configured", label: "검색 추이 연결 필요" }
      : datalabError
        ? { status: "error", label: trendErrorLabel }
        : datalabProfile?.series?.length
          ? { status: "ok", label: "검색 추이 확인" }
          : { status: "pending", label: "검색 추이 대기" },
    ratios: !datalabConfigured
      ? { status: "not_configured", label: "검색 비율 연결 필요" }
      : datalabError
        ? { status: "error", label: datalabErrorLabel }
        : ratioReady && profileReady
          ? { status: "ok", label: "검색 비율 확인" }
          : profilePartial || ratioReady
            ? { status: "partial", label: "일부 검색 비율 확인" }
            : { status: "partial", label: "일부 검색 비율 대기" },
    shopping: !shoppingConfigured
      ? { status: "not_configured", label: "쇼핑 참고 지표 연결 필요" }
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
  if (status.trend.label === "DataLab 한도 초과" || status.ratios.label === "DataLab 한도 초과") {
    return "월 검색량과 쇼핑 지표는 확인됐고, 검색 추이와 비율은 DataLab 한도 복구 후 표시됩니다.";
  }
  if (status.trend.status === "not_configured" && status.ratios.status === "not_configured") {
    return "월 검색량은 확인됐고, 검색 추이와 검색 비율은 연결 후 표시됩니다.";
  }
  if (status.ratios.status === "not_configured") {
    return "월 검색량과 검색 추이는 확인됐고, 검색 비율은 연결 후 표시됩니다.";
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
        code: "NAVER_SEARCHAD_NOT_CONFIGURED",
        message: "키워드 데이터 연결이 준비되지 않았습니다. 관리자에게 문의해주세요.",
        sourceStatus: {
          searchVolume: { status: "not_configured", label: "월 검색량 연결 필요" },
        },
      }, 503);
    }

    const cacheKey = keywordCacheKey(keyword, profileMode, env);
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

      if (hasOpenapiConfig(env)) {
        try {
          shoppingProfile = buildShoppingProfile(await fetchNaverShoppingSearch(env, keyword));
        } catch (error) {
          shoppingError = error.message;
        }
      }

      if (hasDatalabConfig(env)) {
        try {
          datalabProfile = await buildDatalabProfile(env, keyword, {
            includeProfile,
            shoppingCategoryId: shoppingProfile?.categoryId || "",
          });
        } catch (error) {
          datalabError = error.message;
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
          migratedApiProvider: resolveNaverApiTransport(env.naverApi, "datalab"),
        },
        sourceStatus,
        userMessage: sourceUserMessage(sourceStatus),
        warnings,
        chartData: buildChartData(keyword, searchAd, datalabProfile, shoppingProfile),
        cache: { hit: false, ttlSeconds: Math.ceil(KEYWORD_CACHE_TTL_MS / 1000) },
      };

      if (!datalabError && !shoppingError && canCacheKeywordPayload(payload)) setKeywordCache(cacheKey, payload);
      return json(request, payload);
    } catch (error) {
      return json(request, {
        ok: false,
        message: "키워드 데이터 조회 중 오류가 발생했습니다.",
      }, error.status || 500);
    }
  },
};

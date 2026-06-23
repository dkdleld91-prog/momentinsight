import crypto from "node:crypto";
import { corsHeaders, featureEnabled, protectedJson } from "../security.mjs";

const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const DATALAB_BASE_URL = "https://openapi.naver.com";

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

function normalizeKeyword(keyword) {
  return String(keyword || "").replace(/\s+/g, " ").trim();
}

function normalizeCompare(keyword) {
  return normalizeKeyword(keyword).replace(/\s/g, "").toLowerCase();
}

function normalizeSearchAdKeyword(keyword) {
  return normalizeKeyword(keyword).replace(/\s/g, "");
}

function safeErrorPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    status: payload.status || null,
    type: payload.type || null,
    title: payload.title || null,
  };
}

function parseNaverNumber(value) {
  if (typeof value === "number") return value;
  if (!value) return 0;
  if (String(value).includes("<")) return 10;
  return Number(String(value).replace(/,/g, "")) || 0;
}

function searchVolumeLabel(pcRaw, mobileRaw, total) {
  const isUnderThreshold = [pcRaw, mobileRaw].some((value) => String(value || "").includes("<"));
  if (isUnderThreshold) return `${Number(total || 0).toLocaleString("ko-KR")} 미만`;
  return Number(total || 0).toLocaleString("ko-KR");
}

function searchVolumeWithUnit(label) {
  const text = String(label || "확인 필요");
  if (text.includes("미만")) return `${text.replace(/\s*미만$/, "")}회 미만`;
  if (text === "확인 필요") return text;
  return `${text}회`;
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function compactDate(date) {
  return date.toISOString().slice(0, 10);
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

async function fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit = "month", device, gender, ages }) {
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

function normalizeShares(entries) {
  const total = entries.reduce((sum, item) => sum + Number(item.value || 0), 0);
  if (!total) {
    const even = Math.round(100 / entries.length);
    return entries.map(() => even);
  }
  return entries.map((item) => round((Number(item.value || 0) / total) * 100, 0));
}

function trendToSeries(trendPayload, totalVolume) {
  const data = trendPayload?.results?.[0]?.data || [];
  if (!data.length) return [];
  const base = Number(totalVolume || 0);
  return data.map((item) => {
    const ratio = Number(item.ratio || 0);
    return Math.max(0, Math.round(base ? (base * ratio) / 100 : ratio * 100));
  });
}

function weekdayHeights(dailyPayload) {
  const data = dailyPayload?.results?.[0]?.data || [];
  const sums = [0, 0, 0, 0, 0, 0, 0];
  data.forEach((item) => {
    const date = new Date(`${item.period}T00:00:00+09:00`);
    const day = date.getDay();
    sums[day === 0 ? 6 : day - 1] += Number(item.ratio || 0);
  });
  const max = Math.max(...sums, 1);
  return sums.map((value) => Math.max(10, Math.round((value / max) * 100)));
}

async function buildDatalabProfile(env, keyword, totalVolume) {
  const endDate = compactDate(dateDaysAgo(1));
  const startDate = compactDate(monthsAgo(12));
  const dailyStartDate = compactDate(dateDaysAgo(28));

  const trend = await fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit: "month" });
  const [male, female, age10, age20, age30, age40, age50, age60, daily] = await Promise.all([
    fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit: "month", gender: "m" }),
    fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit: "month", gender: "f" }),
    fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit: "month", ages: ["2"] }),
    fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit: "month", ages: ["3", "4"] }),
    fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit: "month", ages: ["5", "6"] }),
    fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit: "month", ages: ["7", "8"] }),
    fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit: "month", ages: ["9", "10"] }),
    fetchDatalabSearch(env, { keyword, startDate, endDate, timeUnit: "month", ages: ["11"] }),
    fetchDatalabSearch(env, { keyword, startDate: dailyStartDate, endDate, timeUnit: "date" }),
  ]);

  const genderShares = normalizeShares([
    { label: "male", value: ratioSum(male) },
    { label: "female", value: ratioSum(female) },
  ]);
  const ageShares = normalizeShares([
    { label: "10", value: ratioSum(age10) },
    { label: "20", value: ratioSum(age20) },
    { label: "30", value: ratioSum(age30) },
    { label: "40", value: ratioSum(age40) },
    { label: "50", value: ratioSum(age50) },
    { label: "60", value: ratioSum(age60) },
  ]);

  return {
    series: trendToSeries(trend, totalVolume),
    gender: { male: genderShares[0], female: genderShares[1] },
    age: ageShares,
    week: weekdayHeights(daily),
  };
}

function makeFallbackSeries(volume) {
  const base = Number(volume || 0);
  return [0.43, 0.74, 1, 0.91, 0.76, 0.62, 0.72, 0.79, 0.66, 0.53, 0.96, 0.58].map((ratio, index) => {
    const wave = (((base / 100) + index * 17) % 23) / 100;
    return Math.max(800, Math.round(base * Math.min(1.08, ratio + wave)));
  });
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
    source: "shopping_profile",
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

      const pcVolume = parseNaverNumber(item.monthlyPcQcCnt);
      const mobileVolume = parseNaverNumber(item.monthlyMobileQcCnt);
      const volume = pcVolume + mobileVolume;
      const comp = competitionLabel(item.compIdx);
      const volumeLabel = searchVolumeLabel(item.monthlyPcQcCnt, item.monthlyMobileQcCnt, volume);

      return {
        keyword,
        volume,
        volumeLabel,
        pcVolume,
        mobileVolume,
        comp,
        source: "monthly_search",
      };
    })
    .filter(Boolean);
}

function buildChartData(keyword, searchAd, datalabProfile, shoppingProfile) {
  const item = searchAd?.item || {};
  const hasExactMatch = Boolean(searchAd?.hasExactMatch && searchAd?.item);
  const pcVolume = parseNaverNumber(item.monthlyPcQcCnt);
  const mobileVolume = parseNaverNumber(item.monthlyMobileQcCnt);
  const volume = pcVolume + mobileVolume;
  const safeVolume = hasExactMatch ? volume : 0;
  const volumeLabel = hasExactMatch ? searchVolumeLabel(item.monthlyPcQcCnt, item.monthlyMobileQcCnt, safeVolume) : "확인 필요";
  const mobileShare = safeVolume ? Math.round((mobileVolume / safeVolume) * 100) : 0;
  const pcShare = safeVolume ? 100 - mobileShare : 0;
  const comp = hasExactMatch ? competitionLabel(item.compIdx) : "확인 필요";
  const relatedKeywordMetrics = buildRelatedKeywordMetrics(searchAd);

  return {
    keyword,
    matchedKeyword: hasExactMatch ? item.relKeyword || keyword : "",
    volumeStatus: hasExactMatch ? "확인됨" : "확인 필요",
    volumeLabel,
    trendStatus: datalabProfile?.series?.length ? "확인됨" : "수집 대기",
    volume: safeVolume,
    comp,
    action: hasExactMatch
      ? comp === "높음" ? "검색량은 크지만 경쟁이 높아 콘텐츠와 광고 소재를 분리 운영" : "검색량과 경쟁도를 기준으로 SEO 후보로 분류"
      : "정확한 월 검색량이 확인되지 않아 연관 키워드를 개별 조회",
    insight: hasExactMatch
      ? `월 검색량 ${searchVolumeWithUnit(volumeLabel)}, 시장 경쟁도 ${comp}입니다.`
      : "정확한 월 검색량이 확인되지 않았습니다. 연관 키워드를 개별 조회해주세요.",
    series: datalabProfile?.series?.length ? datalabProfile.series : [],
    device: { mobile: mobileShare, pc: pcShare },
    gender: datalabProfile?.gender || null,
    age: datalabProfile?.age || [],
    week: datalabProfile?.week || [],
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

    const env = config();
    if (!hasSearchAdConfig(env)) {
      return json(request, {
        ok: false,
        message: "키워드 데이터 연결이 준비되지 않았습니다. 관리자에게 문의해주세요.",
      }, 503);
    }

    try {
      const searchAd = await fetchSearchAdKeyword(env, keyword);
      const baseVolume = parseNaverNumber(searchAd.item?.monthlyPcQcCnt) + parseNaverNumber(searchAd.item?.monthlyMobileQcCnt);
      let datalabProfile = null;
      let datalabError = null;
      let shoppingProfile = null;
      let shoppingError = null;

      if (hasDatalabConfig(env) && baseVolume > 0) {
        try {
          datalabProfile = await buildDatalabProfile(env, keyword, baseVolume);
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

      return json(request, {
        ok: true,
        source: {
          searchVolume: "monthly_search",
          trend: datalabProfile ? "trend_profile" : "estimated_trend",
          shopping: shoppingProfile ? "shopping_profile" : hasOpenapiConfig(env) ? "partial" : "pending",
        },
        chartData: buildChartData(keyword, searchAd, datalabProfile, shoppingProfile),
      });
    } catch (error) {
      return json(request, {
        ok: false,
        message: "키워드 데이터 조회 중 오류가 발생했습니다.",
      }, error.status || 500);
    }
  },
};

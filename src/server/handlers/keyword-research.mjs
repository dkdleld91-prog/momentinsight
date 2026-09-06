// 키워드 조회 2차 보조 데이터(2026-09-06) — 이미 연동된 API에서 안 쓰던 값만 모아 돌려준다.
//
//   - 검색광고 키워드도구(showDetail): 광고 노출 깊이(plAvgDepth)·경쟁도
//   - 검색광고 입찰가·예상 실적(estimate): 노출 순위별 예상 입찰가, 1위 노출 시 예상 클릭·비용
//   - 네이버 검색 API(blog·cafearticle·kin): 콘텐츠 총량, 블로그 최근 30일 발행량, 지식iN 최신 질문
//
// 잠금 파일(naver-keyword.mjs)은 건드리지 않고 별도 리소스로 연다. 순위추적과 무관하며 DB를 쓰지 않는다.
// 섹션별로 독립 실패({ ok: false, reason })하고, 키워드당 24시간 메모리 캐시로 호출을 줄인다.
import crypto from "node:crypto";

import { naverApiProviderConfig, naverSearchRequest } from "../naver-api-hub.mjs";

const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4500;
const BID_POSITIONS = [1, 3, 5];
const BLOG_RECENT_DAYS = 30;
const KIN_QUESTION_LIMIT = 2;

const cache = new Map();

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function normalizeKeyword(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function compactKeyword(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// ── 검색광고 API ─────────────────────────────────────────────────
function searchAdConfigured(env) {
  return Boolean(env.NAVER_SEARCHAD_API_KEY && env.NAVER_SEARCHAD_SECRET_KEY && env.NAVER_SEARCHAD_CUSTOMER_ID);
}

function searchAdHeaders(env, method, path) {
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", env.NAVER_SEARCHAD_SECRET_KEY)
    .update(`${timestamp}.${method}.${path}`)
    .digest("base64");
  return {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp": timestamp,
    "X-API-KEY": env.NAVER_SEARCHAD_API_KEY,
    "X-Customer": String(env.NAVER_SEARCHAD_CUSTOMER_ID),
    "X-Signature": signature,
  };
}

async function searchAdRequest(env, method, path, { query = null, body = null } = {}) {
  const url = new URL(path, SEARCHAD_BASE_URL);
  if (query) Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const guard = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: searchAdHeaders(env, method, path),
      body: body ? JSON.stringify(body) : undefined,
      signal: guard.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`searchad_http_${response.status}`);
    return payload;
  } finally {
    guard.done();
  }
}

export function pickExactKeywordRow(keywordList, keyword) {
  const target = compactKeyword(keyword);
  const rows = Array.isArray(keywordList) ? keywordList : [];
  return rows.find((row) => compactKeyword(row?.relKeyword) === target) || null;
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).replace(/[^0-9.\-]/g, "");
  if (text === "" && /</.test(String(value))) return 5; // "< 10" 같은 하한 표기는 5로 본다
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

// 연관 키워드 지표(6안 7번 블록): 같은 keywordstool 응답에서 검색수·클릭·클릭률·노출 깊이를 뽑는다. 추가 호출 없음.
export function relatedKeywordMetrics(keywordList, keyword, limit = 40) {
  const target = compactKeyword(keyword);
  const rows = Array.isArray(keywordList) ? keywordList : [];
  const out = [];
  for (const row of rows) {
    const name = String(row?.relKeyword || "").trim();
    if (!name || compactKeyword(name) === target) continue;
    const pc = numberOrNull(row.monthlyPcQcCnt);
    const mobile = numberOrNull(row.monthlyMobileQcCnt);
    const volume = pc === null && mobile === null ? null : (pc || 0) + (mobile || 0);
    const pcClicks = numberOrNull(row.monthlyAvePcClkCnt);
    const mobileClicks = numberOrNull(row.monthlyAveMobileClkCnt);
    const clicks = pcClicks === null && mobileClicks === null ? null : Math.round(((pcClicks || 0) + (mobileClicks || 0)) * 10) / 10;
    const ctr = volume && clicks !== null ? Math.round((clicks / volume) * 10000) / 100 : null;
    out.push({ keyword: name, volume, pcVolume: pc, mobileVolume: mobile, clicks, ctr, depth: numberOrNull(row.plAvgDepth), competition: String(row.compIdx || "") });
    if (out.length >= limit) break;
  }
  return out;
}

async function loadAdDepth(env, keyword) {
  if (!searchAdConfigured(env)) return { ok: false, reason: "not_configured" };
  const payload = await searchAdRequest(env, "GET", "/keywordstool", {
    query: { hintKeywords: keyword.replace(/\s+/g, ""), showDetail: 1 },
  });
  const related = relatedKeywordMetrics(payload?.keywordList, keyword);
  const row = pickExactKeywordRow(payload?.keywordList, keyword);
  if (!row) return { ok: false, reason: "no_exact_match", related };
  return {
    ok: true,
    depth: numberOrNull(row.plAvgDepth),
    competition: String(row.compIdx || ""),
    monthlyPcClicks: numberOrNull(row.monthlyAvePcClkCnt),
    monthlyMobileClicks: numberOrNull(row.monthlyAveMobileClkCnt),
    related,
  };
}

export function parseBidEstimate(payload) {
  const list = Array.isArray(payload?.estimate) ? payload.estimate : [];
  const bids = {};
  list.forEach((entry) => {
    const position = Number(entry?.position);
    const bid = numberOrNull(entry?.bid);
    if (Number.isFinite(position) && bid !== null) bids[position] = bid;
  });
  return bids;
}

export function parsePerformanceEstimate(payload) {
  const list = Array.isArray(payload?.estimate) ? payload.estimate : [];
  const first = list[0];
  if (!first) return null;
  return {
    bid: numberOrNull(first.bid),
    impressions: numberOrNull(first.impressions),
    clicks: numberOrNull(first.clicks),
    cost: numberOrNull(first.cost),
  };
}

async function loadBids(env, keyword) {
  if (!searchAdConfigured(env)) return { ok: false, reason: "not_configured" };
  const key = keyword.replace(/\s+/g, "");
  const bidPayload = await searchAdRequest(env, "POST", "/estimate/average-position-bid/keyword", {
    body: { device: "MOBILE", items: BID_POSITIONS.map((position) => ({ key, position })) },
  });
  const bids = parseBidEstimate(bidPayload);
  if (!Object.keys(bids).length) return { ok: false, reason: "no_bid_estimate" };
  let expected = null;
  if (bids[1]) {
    try {
      const performancePayload = await searchAdRequest(env, "POST", "/estimate/performance/keyword", {
        body: { device: "MOBILE", keywordplus: false, key, bids: [bids[1]] },
      });
      expected = parsePerformanceEstimate(performancePayload);
    } catch {
      expected = null;
    }
  }
  return { ok: true, device: "MOBILE", bids, expected };
}

// ── 네이버 검색 API(블로그·카페·지식iN) ─────────────────────────
async function searchTotal(config, resource, keyword, params = {}) {
  const query = new URLSearchParams({ query: keyword, display: "1", ...params });
  const request = naverSearchRequest(config, resource, query);
  const guard = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, { headers: request.headers, signal: guard.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${resource}_http_${response.status}`);
    return payload;
  } finally {
    guard.done();
  }
}

export function countRecentPostdates(items, nowMs, days = BLOG_RECENT_DAYS) {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  return (Array.isArray(items) ? items : []).filter((item) => {
    const text = String(item?.postdate || "");
    if (!/^\d{8}$/.test(text)) return false;
    const ms = Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
    return ms >= cutoff;
  }).length;
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();
}

async function loadContentMarket(config, keyword, nowMs) {
  const [blog, blogRecent, cafe, kin] = await Promise.allSettled([
    searchTotal(config, "blog", keyword),
    searchTotal(config, "blog", keyword, { display: "100", sort: "date" }),
    searchTotal(config, "cafearticle", keyword),
    searchTotal(config, "kin", keyword, { display: String(KIN_QUESTION_LIMIT), sort: "date" }),
  ]);
  const value = (settled) => (settled.status === "fulfilled" ? settled.value : null);
  const blogPayload = value(blog);
  const cafePayload = value(cafe);
  const kinPayload = value(kin);
  if (!blogPayload && !cafePayload && !kinPayload) return { ok: false, reason: "search_unavailable" };
  return {
    ok: true,
    blog: blogPayload ? { total: numberOrNull(blogPayload.total), recent30d: value(blogRecent) ? countRecentPostdates(value(blogRecent).items, nowMs) : null } : null,
    cafe: cafePayload ? { total: numberOrNull(cafePayload.total) } : null,
    kin: kinPayload
      ? {
        total: numberOrNull(kinPayload.total),
        questions: (Array.isArray(kinPayload.items) ? kinPayload.items : []).slice(0, KIN_QUESTION_LIMIT).map((item) => ({ title: stripTags(item?.title), link: String(item?.link || "") })),
      }
      : null,
  };
}

// ── 핸들러 ───────────────────────────────────────────────────────
export async function handleKeywordResearchRequest(request) {
  if (request.method !== "GET") return json({ ok: false, message: "Method not allowed" }, 405);
  const role = String(request.headers.get("x-mi-session-role") || "").trim().toLowerCase();
  if (!role) return json({ ok: false, message: "세션 역할을 확인할 수 없습니다." }, 401);
  const keyword = normalizeKeyword(new URL(request.url).searchParams.get("keyword"));
  if (!keyword) return json({ ok: false, message: "keyword 파라미터가 필요합니다." }, 400);

  const nowMs = Date.now();
  const cacheKey = compactKeyword(keyword);
  const hit = cache.get(cacheKey);
  if (hit && nowMs - hit.storedAt <= CACHE_TTL_MS) return json(hit.value);

  const env = process.env;
  const config = naverApiProviderConfig(env);
  const [depth, bids, content] = await Promise.all([
    loadAdDepth(env, keyword).catch((error) => ({ ok: false, reason: String(error?.message || "depth_unavailable") })),
    loadBids(env, keyword).catch((error) => ({ ok: false, reason: String(error?.message || "bids_unavailable") })),
    loadContentMarket(config, keyword, nowMs).catch((error) => ({ ok: false, reason: String(error?.message || "content_unavailable") })),
  ]);
  const value = { ok: true, keyword, checkedAt: new Date(nowMs).toISOString(), ads: { depth, bids }, content };
  cache.set(cacheKey, { storedAt: nowMs, value });
  return json(value);
}

export default {
  fetch(request) {
    return handleKeywordResearchRequest(request);
  },
};

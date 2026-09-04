// 시장 홈 피드 — 운영 홈(admin)과 광고주 대시보드(client)가 함께 쓰는 읽기 전용 집계.
//
// 이 파일은 순위추적 수집·판정에 절대 관여하지 않는다.
//   - naver_rank_trackers / naver_rank_snapshots 는 select 만 한다(insert/update/delete/RPC 금지).
//   - 순위 관련 잠금 파일은 import 만 하고 수정하지 않는다.
//   - 새 외부 호출(뉴스·데이터랩·검색광고)은 전부 자체 타임아웃·메모리 캐시를 가져
//     실패하더라도 순위 수집과 자원을 다투지 않는다.
//
// 응답은 섹션별로 독립이다. 한 섹션이 실패해도 다른 섹션은 그대로 채워지고,
// 실패한 섹션만 { ok: false, reason } 으로 내려간다. 화면은 그 자리에 빈 상태를 그린다.
import crypto from "node:crypto";
import { withSupabase } from "@supabase/server";

import { corsHeaders, protectedJson } from "../security.mjs";
import {
  naverApiErrorMessage,
  naverApiProviderConfig,
  naverDatalabRequest,
  naverSearchRequest,
} from "../naver-api-hub.mjs";
import { RANK_NEVER_FOUND_MIN_CHECKS } from "../naver-rank-requeue.mjs";

const SEARCHAD_BASE_URL = "https://api.searchad.naver.com";

const NEWS_CACHE_TTL_MS = 60 * 60 * 1000; // 기사 1시간
const METRIC_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 지표·키워드 뉴스 24시간
const NEWS_FETCH_TIMEOUT_MS = 4000;
const SEARCHAD_TIMEOUT_MS = 4000;
const DATALAB_TIMEOUT_MS = 6000;
const HANDLER_BUDGET_MS = 15000; // 화면 miFetch 기본 타임아웃(20초)보다 짧게 — 초과분은 부분 결과

const VOLUME_KEYWORD_LIMIT = 20; // 비용 보호: 검색량 조회는 최대 20개
const KEYWORD_NEWS_LIMIT = 6;
const DATALAB_GROUP_LIMIT = 5; // 데이터랩은 keywordGroups 5개를 넘기면 400
const SEARCHAD_CONCURRENCY = 2;
const SEARCHAD_GAP_MS = 120;
const RANK_SWING_MIN_DELTA = 10;
const RANK_SWING_LIMIT = 6;

// ── 기사 규칙 ────────────────────────────────────────────────────
export const NAVER_NEWS_QUERIES = ['"네이버 커머스"', '"네이버쇼핑"', '"스마트스토어"'];
export const COUPANG_NEWS_QUERIES = [
  '"쿠팡"',
  '"쿠팡" 입점',
  '"쿠팡 정산"',
  '"쿠팡" "셀러"',
  '"쿠팡" 수수료',
  '"쿠팡" 판매자',
];

const COMMERCE_CONTEXT_RE = /셀러|판매자|입점|수수료|정산|물류|배송|풀필먼트|커머스|쇼핑|마켓플레이스|이커머스|스마트스토어|오픈마켓|유통|납품|가격비교|검색 ?광고|공정위|거래액|플랫폼/;
const COMMERCE_EXCLUDE_RE = /드라마|배우|영화|예능|OTT|아이돌|가수|앨범|콘서트|시청률|야구|축구|파병|국방|외교|로또|코인|쿠팡이츠|쿠팡플레이|와우 ?히어로|쿠팡친구|쿠팡맨|도로|개통|화재 진압|최대 \d+% ?할인|할인전|기념 이벤트/;
const NAVER_TITLE_RE = /네이버|스마트스토어/;
const COUPANG_SELLER_RE = /셀러|판매자|입점|수수료|정산|납품|마켓플레이스|공정위|규제|법안|검색|노출|리뷰|광고|가격|플랫폼|이커머스|커머스|유통업계|점유율|거래액/;
const COUPANG_PR_RE = /로지스틱스|CLS|봉사|기부|후원|지원|채용|인재|어워즈|선정|새단장|장학|캠페인/;
const TOPIC_KEYWORDS = ["정산", "수수료", "물류", "규제", "광고", "시장", "결제", "기획전", "커머스"];

const NEWS_WINDOW_DAYS = 7;
const DEDUPE_KEY_LENGTH = 22;
const LIST_ITEM_LIMIT = 3;

// 모듈 스코프 메모리 캐시. 마이그레이션·캐시 테이블 없이 인스턴스 수명 동안만 산다.
const newsCache = new Map();
const metricCache = new Map();

function cacheRead(store, key, ttlMs, nowMs) {
  const hit = store.get(key);
  if (!hit) return { fresh: null, stale: null };
  if (nowMs - hit.storedAt <= ttlMs) return { fresh: hit.value, stale: hit.value };
  return { fresh: null, stale: hit.value };
}

function cacheWrite(store, key, value, nowMs) {
  store.set(key, { storedAt: nowMs, value });
  return value;
}

export function resetHomeFeedCaches() {
  newsCache.clear();
  metricCache.clear();
}

// ── 순수 함수: 문자열·기사 ────────────────────────────────────────
export function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeKey(title) {
  return String(title || "").replace(/\s+/g, "").slice(0, DEDUPE_KEY_LENGTH);
}

export function articleTopic(title) {
  const text = String(title || "");
  return TOPIC_KEYWORDS.find((topic) => text.includes(topic)) || "";
}

export function sourceHost(link) {
  try {
    return new URL(String(link || "")).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isWithinWindow(publishedMs, nowMs, days = NEWS_WINDOW_DAYS) {
  if (!Number.isFinite(publishedMs)) return false;
  if (publishedMs > nowMs + 60 * 60 * 1000) return false; // 미래 날짜는 버린다
  return nowMs - publishedMs <= days * 24 * 60 * 60 * 1000;
}

export function passesBrandTitleGate(brand, title) {
  const text = String(title || "");
  if (brand === "naver") return NAVER_TITLE_RE.test(text);
  if (brand === "coupang") {
    return text.includes("쿠팡") && COUPANG_SELLER_RE.test(text) && !COUPANG_PR_RE.test(text);
  }
  return false;
}

export function passesCommerceGate(title, description) {
  const text = `${String(title || "")} ${String(description || "")}`;
  if (!COMMERCE_CONTEXT_RE.test(text)) return false;
  if (COMMERCE_EXCLUDE_RE.test(text)) return false;
  return true;
}

// 질의 순서를 우선하고, 같은 질의 안에서는 API 반환 순서(=관련도)를 우선한다.
// 그 다음 중복을 제거한다. 결과 배열의 0번이 곧 관련도 1위다.
export function collectArticles(brand, groups, nowMs) {
  const seen = new Set();
  const articles = [];
  groups.forEach((items, queryIndex) => {
    (Array.isArray(items) ? items : []).forEach((item, itemIndex) => {
      const title = stripHtml(item?.title);
      const description = stripHtml(item?.description);
      if (!title) return;
      const publishedMs = Date.parse(item?.pubDate || "");
      if (!isWithinWindow(publishedMs, nowMs)) return;
      if (!passesBrandTitleGate(brand, title)) return;
      if (!passesCommerceGate(title, description)) return;
      const key = dedupeKey(title);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const link = String(item?.originallink || item?.link || "");
      articles.push({
        title,
        link,
        source: sourceHost(item?.originallink || item?.link),
        publishedAt: new Date(publishedMs).toISOString(),
        publishedMs,
        topic: articleTopic(title),
        queryIndex,
        itemIndex,
      });
    });
  });
  return articles;
}

// 리드 = 관련도 1위(질의 순서 → 반환 순서). 동률이면 최신.
export function selectLead(articles) {
  if (!articles.length) return null;
  let lead = articles[0];
  for (const candidate of articles) {
    const sameRank = candidate.queryIndex === lead.queryIndex && candidate.itemIndex === lead.itemIndex;
    const better = candidate.queryIndex < lead.queryIndex
      || (candidate.queryIndex === lead.queryIndex && candidate.itemIndex < lead.itemIndex);
    if (better || (sameRank && candidate.publishedMs > lead.publishedMs)) lead = candidate;
  }
  return lead;
}

export function buildBrandSection(brand, groups, nowMs) {
  const articles = collectArticles(brand, groups, nowMs);
  const lead = selectLead(articles);
  const rest = articles
    .filter((article) => article !== lead)
    .sort((a, b) => b.publishedMs - a.publishedMs)
    .slice(0, LIST_ITEM_LIMIT);
  return {
    count7d: articles.length,
    lead: lead ? publicArticle(lead) : null,
    items: rest.map(publicArticle),
  };
}

function publicArticle(article) {
  return {
    title: article.title,
    link: article.link,
    source: article.source,
    publishedAt: article.publishedAt,
    topic: article.topic,
  };
}

// ── 순수 함수: 주간 검색 트렌드 ──────────────────────────────────
// 데이터랩 주간 버킷은 시작일 기준이다. 오늘이 포함된 주는 아직 덜 쌓였으므로
// 그대로 비교하면 모든 키워드가 급락한 것처럼 보인다. 완결된 주만 쓴다.
export function weekIsComplete(period, nowMs) {
  const startMs = Date.parse(`${String(period || "")}T00:00:00Z`);
  if (!Number.isFinite(startMs)) return false;
  return startMs + 7 * 24 * 60 * 60 * 1000 <= nowMs;
}

export function completeWeeklyPoints(dataPoints, nowMs) {
  return (Array.isArray(dataPoints) ? dataPoints : []).filter((point) => weekIsComplete(point?.period, nowMs));
}

export function weeklyChangePct(dataPoints, nowMs) {
  const complete = completeWeeklyPoints(dataPoints, nowMs);
  if (complete.length < 2) return null;
  const last = Number(complete[complete.length - 1]?.ratio || 0);
  const prev = Number(complete[complete.length - 2]?.ratio || 0);
  if (!(prev > 0)) return null;
  return Math.round(((last - prev) / prev) * 1000) / 10;
}

export function chunk(list, size) {
  const source = Array.isArray(list) ? list : [];
  const out = [];
  for (let index = 0; index < source.length; index += size) out.push(source.slice(index, index + size));
  return out;
}

// ── 순수 함수: 검색량 파싱(검색광고 "< 10" 규약을 그대로 따른다) ──
export function parseSearchCount(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  if (text.includes("<")) return 0;
  return Number(text.replace(/,/g, "")) || 0;
}

export function monthlyVolumeOf(item) {
  if (!item) return null;
  return parseSearchCount(item.monthlyPcQcCnt) + parseSearchCount(item.monthlyMobileQcCnt);
}

// ── 순수 함수: 순위(읽기 전용 집계) ──────────────────────────────
export function normalizeAgencyCode(value) {
  return String(value || "").trim().toLowerCase();
}

export function agencyCodeScope(agencyCode, env = process.env) {
  const primary = normalizeAgencyCode(env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
  const legacy = String(env.MI_LEGACY_AGENCY_CODES || "")
    .split(",")
    .map((value) => normalizeAgencyCode(value))
    .filter(Boolean);
  const code = normalizeAgencyCode(agencyCode);
  if (!code) return [];
  const canonical = legacy.includes(code) ? primary : code;
  const scope = [canonical];
  if (canonical === primary) scope.push(...legacy);
  return [...new Set(scope.filter(Boolean))];
}

// 원부 미매칭은 이 저장소의 기존 규약(neverFound)을 그대로 쓴다.
// naver_rank_trackers 에는 매칭 전용 컬럼이 없다.
export function trackerNeverFound(tracker) {
  return Number(tracker?.check_count || 0) >= RANK_NEVER_FOUND_MIN_CHECKS
    && Number(tracker?.found_count || 0) === 0;
}

function dayKey(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

// 트래커별로 최신 2일치 스냅샷을 뽑아 어제 대비 변동을 만든다.
export function latestTwoDayRanks(snapshots) {
  const byTracker = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const trackerId = snapshot?.tracker_id;
    if (!trackerId) continue;
    const day = dayKey(snapshot?.checked_at);
    if (!day) continue;
    if (!byTracker.has(trackerId)) byTracker.set(trackerId, new Map());
    const days = byTracker.get(trackerId);
    const existing = days.get(day);
    const checkedMs = Date.parse(snapshot.checked_at);
    if (!existing || checkedMs > existing.checkedMs) {
      days.set(day, {
        checkedMs,
        rank: Number.isFinite(Number(snapshot.rank)) ? Number(snapshot.rank) : null,
        matched: snapshot.matched === true,
      });
    }
  }
  const out = new Map();
  for (const [trackerId, days] of byTracker) {
    const ordered = [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map((entry) => entry[1]);
    out.set(trackerId, { latest: ordered[0] || null, previous: ordered[1] || null });
  }
  return out;
}

export function computeRankSwings(trackers, snapshots, limit = RANK_SWING_LIMIT) {
  const ranks = latestTwoDayRanks(snapshots);
  const swings = [];
  for (const tracker of Array.isArray(trackers) ? trackers : []) {
    const pair = ranks.get(tracker?.id);
    if (!pair?.latest || !pair?.previous) continue;
    const toRank = pair.latest.rank;
    const fromRank = pair.previous.rank;
    if (!Number.isFinite(toRank) || !Number.isFinite(fromRank)) continue;
    const delta = fromRank - toRank; // 양수 = 순위 상승
    if (Math.abs(delta) < RANK_SWING_MIN_DELTA) continue;
    swings.push({
      accountCode: tracker.agency_code || "",
      keyword: tracker.keyword || "",
      fromRank,
      toRank,
      delta,
    });
  }
  return swings.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, limit);
}

export function computeRankSummary(trackers, snapshots) {
  const ranks = latestTwoDayRanks(snapshots);
  const list = Array.isArray(trackers) ? trackers : [];
  let up = 0;
  let down = 0;
  let unchanged = 0;
  let unmatched = 0;
  let lastCollectedMs = 0;
  for (const tracker of list) {
    if (trackerNeverFound(tracker)) unmatched += 1;
    const checkedMs = Date.parse(String(tracker?.last_checked_at || ""));
    if (Number.isFinite(checkedMs) && checkedMs > lastCollectedMs) lastCollectedMs = checkedMs;
    const pair = ranks.get(tracker?.id);
    if (!pair?.latest || !pair?.previous) continue;
    const toRank = pair.latest.rank;
    const fromRank = pair.previous.rank;
    if (!Number.isFinite(toRank) || !Number.isFinite(fromRank)) continue;
    if (toRank < fromRank) up += 1;
    else if (toRank > fromRank) down += 1;
    else unchanged += 1;
  }
  return {
    trackedCount: list.length,
    up,
    down,
    unchanged,
    unmatched,
    lastCollectedAt: lastCollectedMs ? new Date(lastCollectedMs).toISOString() : null,
  };
}

// ── 역할·대상 판정 ───────────────────────────────────────────────
// 세션 게이트가 심어 준 헤더만 신뢰한다. 쿼리스트링으로는 대상을 바꿀 수 없다.
export function resolveScope(request, env = process.env) {
  const role = String(request.headers.get("x-mi-session-role") || "").trim().toLowerCase();
  const headerCode = normalizeAgencyCode(request.headers.get("x-mi-agency-code") || "");
  const teamCode = normalizeAgencyCode(request.headers.get("x-mi-team-code") || "");
  const primary = normalizeAgencyCode(env.MI_PRIMARY_AGENCY_CODE || "mml93-a01");
  const ownerSession = role === "owner"
    && normalizeAgencyCode(request.headers.get("x-mi-owner-agency-code") || "") === primary;

  if (role === "client") return { ok: true, role, accountCode: headerCode };
  if (role === "team") return { ok: true, role, accountCode: headerCode || teamCode };
  if (role === "owner") {
    const placeholder = !headerCode || headerCode === "owner-session" || headerCode === "session";
    return { ok: true, role, accountCode: placeholder && ownerSession ? "" : headerCode };
  }
  return { ok: false, role: "", accountCode: "" };
}

// ── 외부 호출 ────────────────────────────────────────────────────
function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function searchNews(config, query, display) {
  const params = new URLSearchParams({ query, sort: "sim", display: String(display), start: "1" });
  const apiRequest = naverSearchRequest(config, "news", params);
  const guard = withTimeout(NEWS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(apiRequest.url, { headers: apiRequest.headers, signal: guard.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(naverApiErrorMessage(payload, `HTTP ${response.status}`));
    return Array.isArray(payload?.items) ? payload.items : [];
  } finally {
    guard.done();
  }
}

async function loadNewsSection(config, nowMs) {
  const cacheKey = "market-news";
  const cached = cacheRead(newsCache, cacheKey, NEWS_CACHE_TTL_MS, nowMs);
  if (cached.fresh) return cached.fresh;
  try {
    const [naverGroups, coupangGroups] = await Promise.all([
      Promise.all(NAVER_NEWS_QUERIES.map((query) => searchNews(config, query, 30).catch(() => []))),
      Promise.all(COUPANG_NEWS_QUERIES.map((query) => searchNews(config, query, 30).catch(() => []))),
    ]);
    const naver = buildBrandSection("naver", naverGroups, nowMs);
    const coupang = buildBrandSection("coupang", coupangGroups, nowMs);
    if (!naver.count7d && !coupang.count7d && cached.stale) return cached.stale;
    return cacheWrite(newsCache, cacheKey, {
      ok: true,
      updatedAt: new Date(nowMs).toISOString(),
      naver,
      coupang,
    }, nowMs);
  } catch (error) {
    if (cached.stale) return cached.stale;
    return { ok: false, reason: String(error?.message || "news_unavailable") };
  }
}

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

async function searchAdVolume(env, keyword) {
  const path = "/keywordstool";
  const params = new URLSearchParams({ hintKeywords: keyword.replace(/\s/g, ""), showDetail: "1" });
  const guard = withTimeout(SEARCHAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${SEARCHAD_BASE_URL}${path}?${params.toString()}`, {
      method: "GET",
      headers: searchAdHeaders(env, "GET", path),
      signal: guard.signal,
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    const list = Array.isArray(payload?.keywordList) ? payload.keywordList : [];
    const compare = (value) => String(value || "").replace(/\s/g, "").toLowerCase();
    const exact = list.find((item) => compare(item.relKeyword) === compare(keyword));
    return monthlyVolumeOf(exact);
  } catch {
    return null;
  } finally {
    guard.done();
  }
}

// 검색광고는 동시성 2 · 간격 120ms 로만 두드린다(순위 수집 쿼터와 분리된 별도 API).
async function collectVolumes(env, keywords, deadlineMs) {
  const volumes = new Map();
  if (!searchAdConfigured(env)) return volumes;
  const queue = [...keywords];
  const workers = Array.from({ length: Math.min(SEARCHAD_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      if (Date.now() > deadlineMs) return;
      const keyword = queue.shift();
      const volume = await searchAdVolume(env, keyword);
      if (volume !== null) volumes.set(keyword, volume);
      await new Promise((resolve) => setTimeout(resolve, SEARCHAD_GAP_MS));
    }
  });
  await Promise.all(workers);
  return volumes;
}

async function datalabWeekly(config, keywords, nowMs) {
  const request = naverDatalabRequest(config, "search-trend");
  const end = new Date(nowMs);
  const start = new Date(nowMs - 34 * 24 * 60 * 60 * 1000);
  const format = (date) => date.toISOString().slice(0, 10);
  const body = {
    startDate: format(start),
    endDate: format(end),
    timeUnit: "week",
    keywordGroups: keywords.map((keyword) => ({ groupName: keyword, keywords: [keyword] })),
  };
  const guard = withTimeout(DATALAB_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
      signal: guard.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => ({}));
    return Array.isArray(payload?.results) ? payload.results : [];
  } catch {
    return [];
  } finally {
    guard.done();
  }
}

async function collectChanges(config, keywords, nowMs, deadlineMs) {
  const changes = new Map();
  for (const group of chunk(keywords, DATALAB_GROUP_LIMIT)) {
    if (Date.now() > deadlineMs) break;
    const results = await datalabWeekly(config, group, nowMs);
    for (const result of results) {
      const pct = weeklyChangePct(result?.data, nowMs);
      if (pct !== null) changes.set(String(result?.title || ""), pct);
    }
  }
  return changes;
}

async function activeTrackers(ctx, accountCode, env) {
  const scope = agencyCodeScope(accountCode, env);
  if (!scope.length) return [];
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_trackers")
    .select("id, agency_code, keyword, status, current_rank, last_checked_at, check_count, found_count")
    .in("agency_code", scope)
    .eq("status", "active")
    .limit(500);
  if (error) throw error;
  return data || [];
}

async function recentSnapshots(ctx, trackerIds, nowMs) {
  if (!trackerIds.length) return [];
  const since = new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await ctx.supabaseAdmin
    .from("naver_rank_snapshots")
    .select("tracker_id, checked_at, rank, matched")
    .in("tracker_id", trackerIds.slice(0, 300))
    .gte("checked_at", since)
    .order("checked_at", { ascending: false })
    .limit(2000);
  if (error) throw error;
  return data || [];
}

function distinctKeywords(trackers) {
  const seen = new Set();
  const keywords = [];
  for (const tracker of trackers) {
    const keyword = String(tracker?.keyword || "").trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push(keyword);
  }
  return keywords;
}

async function loadMetrics(config, env, accountCode, trackers, nowMs, deadlineMs) {
  const keywords = distinctKeywords(trackers);
  const cacheKey = `metrics:${accountCode}:${keywords.slice(0, VOLUME_KEYWORD_LIMIT).join("|")}`;
  const cached = cacheRead(metricCache, cacheKey, METRIC_CACHE_TTL_MS, nowMs);
  if (cached.fresh) return cached.fresh;
  try {
    const sampled = keywords.slice(0, VOLUME_KEYWORD_LIMIT);
    const volumes = await collectVolumes(env, sampled, deadlineMs);
    const changes = await collectChanges(config, sampled, nowMs, deadlineMs);
    const volumeChange = sampled
      .map((keyword) => ({
        keyword,
        monthlyVolume: volumes.has(keyword) ? volumes.get(keyword) : null,
        changePct: changes.has(keyword) ? changes.get(keyword) : null,
      }))
      .filter((row) => row.changePct !== null || row.monthlyVolume !== null)
      .sort((a, b) => Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0))
      .slice(0, 6);
    const payload = {
      ok: true,
      scope: { accountCode, keywordCount: keywords.length },
      volumeChange,
      // 쇼핑인사이트 조회 함수가 naver-keyword.mjs 에서 export 되지 않는다.
      // 잠금 파일을 고쳐야만 되므로 이 배포에서는 연결하지 않는다.
      categoryTrend: { ok: false, reason: "not_wired" },
      demographics: { ok: false, reason: "not_wired" },
    };
    return cacheWrite(metricCache, cacheKey, payload, nowMs);
  } catch (error) {
    if (cached.stale) return cached.stale;
    return { ok: false, reason: String(error?.message || "metrics_unavailable") };
  }
}

async function loadKeywordNews(config, keywords, trackers, nowMs, deadlineMs) {
  const cacheKey = `keyword-news:${keywords.join("|")}`;
  const cached = cacheRead(metricCache, cacheKey, METRIC_CACHE_TTL_MS, nowMs);
  if (cached.fresh) return cached.fresh;
  try {
    const rankByKeyword = new Map();
    for (const tracker of trackers) {
      const keyword = String(tracker?.keyword || "").trim();
      const rank = Number(tracker?.current_rank);
      if (keyword && Number.isFinite(rank) && !rankByKeyword.has(keyword)) rankByKeyword.set(keyword, rank);
    }
    const items = [];
    for (const keyword of keywords) {
      if (Date.now() > deadlineMs) break;
      const raw = await searchNews(config, `"${keyword}"`, 10).catch(() => []);
      const match = raw
        .map((item) => ({
          title: stripHtml(item?.title),
          description: stripHtml(item?.description),
          link: String(item?.originallink || item?.link || ""),
          publishedMs: Date.parse(item?.pubDate || ""),
        }))
        .find((item) => item.title
          && isWithinWindow(item.publishedMs, nowMs)
          && !COMMERCE_EXCLUDE_RE.test(`${item.title} ${item.description}`));
      if (!match) continue;
      items.push({
        keyword,
        title: match.title,
        link: match.link,
        source: sourceHost(match.link),
        publishedAt: new Date(match.publishedMs).toISOString(),
        myRank: rankByKeyword.has(keyword) ? rankByKeyword.get(keyword) : null,
      });
    }
    return cacheWrite(metricCache, cacheKey, { ok: true, items }, nowMs);
  } catch (error) {
    if (cached.stale) return cached.stale;
    return { ok: false, reason: String(error?.message || "keyword_news_unavailable") };
  }
}

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, OPTIONS",
    headers: "content-type, x-mi-agency-code",
  });
}

export async function handleHomeFeedRequest(request, ctx) {
  if (request.method !== "GET") return json(request, { ok: false, message: "Method not allowed" }, 405);

  const env = process.env;
  const nowMs = Date.now();
  const deadlineMs = nowMs + HANDLER_BUDGET_MS;
  const scope = resolveScope(request, env);
  if (!scope.ok) return json(request, { ok: false, message: "세션 역할을 확인할 수 없습니다." }, 401);

  const config = naverApiProviderConfig(env);
  const newsPromise = loadNewsSection(config, nowMs).catch((error) => ({
    ok: false,
    reason: String(error?.message || "news_unavailable"),
  }));

  let trackers = [];
  let trackerError = "";
  if (scope.accountCode) {
    try {
      trackers = await activeTrackers(ctx, scope.accountCode, env);
    } catch (error) {
      trackerError = String(error?.message || "tracker_unavailable");
    }
  } else {
    trackerError = "no_target_account";
  }

  const keywords = distinctKeywords(trackers);
  const metricsPromise = trackerError
    ? Promise.resolve({ ok: false, reason: trackerError })
    : loadMetrics(config, env, scope.accountCode, trackers, nowMs, deadlineMs);
  const keywordNewsPromise = trackerError
    ? Promise.resolve({ ok: false, reason: trackerError })
    : loadKeywordNews(config, keywords.slice(0, KEYWORD_NEWS_LIMIT), trackers, nowMs, deadlineMs);

  let rank = { ok: false, reason: trackerError || "rank_unavailable" };
  if (!trackerError) {
    try {
      const snapshots = await recentSnapshots(ctx, trackers.map((tracker) => tracker.id), nowMs);
      rank = scope.role === "client"
        ? { ok: true, summary: computeRankSummary(trackers, snapshots) }
        : { ok: true, swings: computeRankSwings(trackers, snapshots) };
    } catch (error) {
      rank = { ok: false, reason: String(error?.message || "rank_unavailable") };
    }
  }

  const [news, metrics, keywordNews] = await Promise.all([newsPromise, metricsPromise, keywordNewsPromise]);

  return json(request, {
    ok: true,
    role: scope.role,
    accountCode: scope.accountCode || null,
    news,
    metrics,
    keywordNews,
    rank,
  });
}

const homeFeedFetch = withSupabase({ auth: "none" }, handleHomeFeedRequest);

export default {
  fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, { methods: "GET, OPTIONS", headers: "content-type, x-mi-agency-code" }),
      });
    }
    return homeFeedFetch(request);
  },
};

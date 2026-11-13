// 검색어 트렌드(대표 지시 2026-11-09): 네이버 데이터랩 '검색어트렌드'와 같은 조건으로 주제어를 겹쳐 비교한다.
//
//   - 공식 API HUB `POST /search-trend/v1/search` 한 번만 부른다. 재시도하지 않는다(조회 1회 = API 1건).
//   - 응답은 공개 지수라 계정별 데이터가 없다. 같은 조건은 1시간 재사용해 호출을 줄인다.
//   - 순위 수집과 자원·코드를 공유하지 않고, DB 를 쓰지 않는다. 잠금 파일은 부르기만 한다.
//   - 체험 계정은 경로가 키워드 조회와 같이 열려 있어(세션 게이트) 여기서 직접 막는다.
import crypto from "node:crypto";

import { hasNaverMigratedApiConfig, naverApiProviderConfig, naverDatalabRequest } from "../naver-api-hub.mjs";
import { datalabAllowedForRequest } from "../datalab-access.mjs";

export const SEARCH_TREND_MIN_DATE = "2016-01-01";
export const SEARCH_TREND_MAX_TOPICS = 5;
export const SEARCH_TREND_MAX_KEYWORDS = 20;
const MAX_TEXT = 60;
const MAX_BODY_CHARS = 24_000;
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_LIMIT = 200;
const BURST_WINDOW_MS = 60 * 1000;
const BURST_LIMIT = 20;
const DAILY_LIMIT = 300;
const COUNTER_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_MS = 9 * 60 * 60 * 1000;
const TIME_UNITS = new Set(["date", "week", "month"]);
const DEVICES = new Set(["", "pc", "mo"]);
const GENDERS = new Set(["", "m", "f"]);
const AGES = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// 이 코드가 있어야 5xx 안내 문구가 일반 서버 오류로 바뀌지 않는다(error-safety.mjs).
export const SEARCH_TREND_SOURCE_FAILED = "SEARCH_TREND_SOURCE_FAILED";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// 화면은 문자열만 보낸다. 객체·깊은 배열을 문자열로 바꾸다 예외가 나지 않게 다른 형식은 빈 값으로 본다.
function clean(value) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function validDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

// 네이버 집계가 끝난 날짜는 한국 시간 어제까지다.
export function latestSearchTrendDate(nowMs) {
  return new Date(nowMs + KST_MS - DAY_MS).toISOString().slice(0, 10);
}

function splitKeywords(value) {
  const list = Array.isArray(value) ? value : clean(value).split(",");
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const keyword = clean(entry);
    const id = keyword.toLowerCase();
    if (!keyword || seen.has(id)) continue;
    seen.add(id);
    out.push(keyword);
  }
  return out;
}

function fail(message) {
  return { ok: false, message };
}

export function normalizeSearchTrendInput(input, nowMs) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const rawTopics = Array.isArray(body.topics) ? body.topics : [];
  if (rawTopics.length > SEARCH_TREND_MAX_TOPICS) return fail(`주제어는 ${SEARCH_TREND_MAX_TOPICS}개까지 넣을 수 있습니다.`);
  const topics = [];
  const names = new Set();
  for (const topic of rawTopics) {
    const keywords = splitKeywords(topic?.keywords);
    let name = clean(topic?.name);
    if (!name && !keywords.length) continue;
    if (!name) name = keywords[0];
    if (!keywords.length) keywords.push(name);
    if (keywords.length > SEARCH_TREND_MAX_KEYWORDS) return fail(`한 주제어에 검색어는 ${SEARCH_TREND_MAX_KEYWORDS}개까지 넣을 수 있습니다.`);
    if (name.length > MAX_TEXT || keywords.some((keyword) => keyword.length > MAX_TEXT)) return fail(`주제어와 검색어는 ${MAX_TEXT}자까지 입력할 수 있습니다.`);
    const id = name.toLowerCase();
    if (names.has(id)) return fail(`같은 주제어 이름이 두 번 들어 있습니다: ${name}`);
    names.add(id);
    topics.push({ name, keywords });
  }
  if (!topics.length) return fail("주제어를 1개 이상 입력해 주세요.");

  const startDate = clean(body.startDate);
  const endDate = clean(body.endDate);
  const latest = latestSearchTrendDate(nowMs);
  if (!validDate(startDate) || !validDate(endDate)) return fail("기간을 다시 확인해 주세요.");
  if (startDate < SEARCH_TREND_MIN_DATE) return fail("2016년 1월 이후 조회할 수 있습니다.");
  if (endDate > latest) return fail("종료일은 어제까지 선택할 수 있습니다.");
  if (startDate > endDate) return fail("시작일은 종료일보다 앞이어야 합니다.");

  const timeUnit = clean(body.timeUnit);
  const device = clean(body.device);
  const gender = clean(body.gender);
  if (!TIME_UNITS.has(timeUnit)) return fail("일간·주간·월간 중에서 선택해 주세요.");
  if (!DEVICES.has(device)) return fail("범위를 다시 선택해 주세요.");
  if (!GENDERS.has(gender)) return fail("성별을 다시 선택해 주세요.");
  const rawAges = Array.isArray(body.ages) ? body.ages.map(clean) : [];
  if (rawAges.some((age) => !AGES.has(age))) return fail("연령을 다시 선택해 주세요.");
  const ages = [...new Set(rawAges)].sort((a, b) => Number(a) - Number(b));
  return { ok: true, value: { topics, startDate, endDate, timeUnit, device, gender, ages: ages.length === AGES.size ? [] : ages } };
}

export function searchTrendUpstreamBody(value) {
  return {
    startDate: value.startDate,
    endDate: value.endDate,
    timeUnit: value.timeUnit,
    keywordGroups: value.topics.map((topic) => ({ groupName: topic.name, keywords: topic.keywords })),
    ...(value.device ? { device: value.device } : {}),
    ...(value.gender ? { gender: value.gender } : {}),
    ...(value.ages.length ? { ages: value.ages } : {}),
  };
}

// 값이 없는 구간은 네이버가 아예 보내지 않는다. 0 으로 채우지 않고 받은 구간만 돌려준다.
export function normalizeSearchTrendResults(payload, topics) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const byTitle = new Map(results.map((result) => [clean(result?.title), result]));
  return topics.map((topic) => {
    const result = byTitle.get(topic.name);
    const points = new Map();
    for (const point of Array.isArray(result?.data) ? result.data : []) {
      const period = clean(point?.period);
      const ratio = Number(point?.ratio);
      if (!validDate(period) || point?.ratio === null || point?.ratio === "" || !Number.isFinite(ratio) || ratio < 0) continue;
      points.set(period, ratio);
    }
    return {
      title: topic.name,
      keywords: topic.keywords,
      data: [...points.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([period, ratio]) => ({ period, ratio })),
    };
  });
}

function upstreamFailure(status) {
  console.warn("search_trend_upstream_failed", JSON.stringify({ status }));
  if (status === 400) return json({ ok: false, reason: "source_rejected", message: "네이버가 이 조건을 받지 않았습니다. 검색어 수나 기간을 줄여 다시 조회해 주세요." }, 400);
  if (status === 429) return json({ ok: false, reason: "source_limit", message: "네이버 조회 한도에 걸렸습니다. 잠시 뒤 다시 조회해 주세요." }, 429);
  return json({ ok: false, code: SEARCH_TREND_SOURCE_FAILED, reason: "source_unavailable", message: "네이버 데이터를 불러오지 못했습니다. 잠시 뒤 다시 조회해 주세요." }, 502);
}

function accountKey(request) {
  const headers = request.headers;
  return [headers.get("x-mi-session-role"), headers.get("x-mi-agency-code"), headers.get("x-mi-team-code")]
    .map((value) => clean(value))
    .join(":");
}

export function createSearchTrendHandler({ env = process.env, config = null, fetchImpl = null, now = Date.now } = {}) {
  const cache = new Map();
  const counters = new Map();

  function cacheRead(key, nowMs) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (nowMs - hit.storedAt > CACHE_TTL_MS) {
      cache.delete(key);
      return null;
    }
    return hit.results;
  }

  function cacheWrite(key, results, nowMs) {
    cache.delete(key);
    cache.set(key, { storedAt: nowMs, results });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }

  // 인스턴스별 과다 호출 방지. 네이버를 실제로 부를 때만 센다.
  function allowUpstream(account, nowMs) {
    const day = new Date(nowMs + KST_MS).toISOString().slice(0, 10);
    let counter = counters.get(account);
    if (!counter || counter.day !== day) counter = { day, daily: 0, burst: [] };
    counter.burst = counter.burst.filter((time) => nowMs - time < BURST_WINDOW_MS);
    if (counter.daily >= DAILY_LIMIT || counter.burst.length >= BURST_LIMIT) {
      counters.set(account, counter);
      return false;
    }
    counter.daily += 1;
    counter.burst.push(nowMs);
    counters.delete(account);
    counters.set(account, counter);
    while (counters.size > COUNTER_LIMIT) counters.delete(counters.keys().next().value);
    return true;
  }

  return async function handleSearchTrend(request) {
    if (request.method !== "POST") return json({ ok: false, reason: "method_not_allowed", message: "POST 요청만 가능합니다." }, 405);
    if (!clean(request.headers.get("x-mi-session-role"))) return json({ ok: false, reason: "session_required", message: "로그인 후 이용할 수 있습니다." }, 401);
    if (request.headers.get("x-mi-session-scope") === "trial") {
      return json({ ok: false, code: "TRIAL_LOCKED", reason: "trial_locked", message: "체험 계정은 키워드 조회만 열려 있습니다. 검색어 트렌드는 네이버 이용 정책에 따라 회사 내부용으로만 씁니다." }, 403);
    }
    // 검색어 트렌드는 직원(총관리자·운영팀) 전용 — 네이버 답변(2026-11-13): 광고주 등 외부 제공 불가.
    if (!datalabAllowedForRequest(request)) {
      return json({ ok: false, code: "STAFF_ONLY", reason: "staff_only", message: "검색어 트렌드는 네이버 이용 정책에 따라 회사 내부용으로만 씁니다." }, 403);
    }

    const raw = await request.text().catch(() => "");
    if (raw.length > MAX_BODY_CHARS) return json({ ok: false, reason: "body_too_large", message: "입력한 내용이 너무 깁니다." }, 413);
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return json({ ok: false, reason: "invalid_json", message: "입력한 내용을 읽지 못했습니다." }, 400);
    }

    const nowMs = now();
    const normalized = normalizeSearchTrendInput(input, nowMs);
    if (!normalized.ok) return json({ ok: false, reason: "invalid_input", message: normalized.message }, 400);
    const value = normalized.value;
    const conditions = { startDate: value.startDate, endDate: value.endDate, timeUnit: value.timeUnit, device: value.device, gender: value.gender, ages: value.ages };
    const respond = (results, cached) => json({ ok: true, checkedAt: new Date(nowMs).toISOString(), cached, conditions, results });

    const apiConfig = config || naverApiProviderConfig(env);
    if (!hasNaverMigratedApiConfig(apiConfig, "datalab")) return json({ ok: false, code: "NAVER_DATALAB_NOT_CONFIGURED", reason: "source_not_configured", message: "네이버 데이터 연결을 확인하는 중입니다. 잠시 뒤 다시 조회해 주세요." }, 503);

    const upstreamBody = searchTrendUpstreamBody(value);
    const cacheKey = crypto.createHash("sha256").update(JSON.stringify(upstreamBody)).digest("hex");
    const cached = cacheRead(cacheKey, nowMs);
    if (cached) return respond(cached, true);
    if (!allowUpstream(accountKey(request), nowMs)) return json({ ok: false, reason: "too_many_requests", message: "조회가 너무 많습니다. 잠시 뒤 다시 조회해 주세요." }, 429);

    const upstream = naverDatalabRequest(apiConfig, "search-trend");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const fetcher = fetchImpl || globalThis.fetch;
      const response = await fetcher(upstream.url, { method: "POST", headers: upstream.headers, body: JSON.stringify(upstreamBody), signal: controller.signal });
      if (!response.ok) return upstreamFailure(response.status);
      const payload = await response.json().catch(() => null);
      if (!payload || !Array.isArray(payload.results)) return upstreamFailure(502);
      const results = normalizeSearchTrendResults(payload, value.topics);
      cacheWrite(cacheKey, results, nowMs);
      return respond(results, false);
    } catch (error) {
      if (error?.name === "AbortError") return json({ ok: false, code: SEARCH_TREND_SOURCE_FAILED, reason: "source_timeout", message: "네이버 응답이 늦어 조회하지 못했습니다. 다시 조회해 주세요." }, 504);
      return upstreamFailure(502);
    } finally {
      clearTimeout(timer);
    }
  };
}

export const handleSearchTrendRequest = createSearchTrendHandler();

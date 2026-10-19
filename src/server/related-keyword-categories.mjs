import crypto from "node:crypto";
import { isIP } from "node:net";
import { normalizeRelatedKeyword, relatedKeywordKey, readBoundedJson } from "./category-source-utils.mjs";
import { createCommerceCategorySource, hasCommerceCategoryConfig, commerceCategoryCredentialKey } from "./naver-commerce-category-source.mjs";

export { normalizeRelatedKeyword, relatedKeywordKey, readBoundedJson };

export const CATEGORY_SAMPLE_SCHEMA = "mi.keyword-category-sample.v1";
export const CATEGORY_SAMPLE_SOURCE = "naver_shopping_product_categories";
export const COMMERCE_CATEGORY_SAMPLE_SOURCE = "naver_commerce_catalog_sample";
const MAX_KEYWORDS = 30;
const MAX_SAMPLE_SIZE = 20;
const MAX_CACHE_SIZE = 256;
const MAX_CONCURRENCY = 2;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const SUCCESS_TTL_MS = 24 * 60 * 60_000;
const FAILURE_TTL_MS = 60_000;
const TIMEOUT_MS = 4_000;
const BATCH_TIMEOUT_MS = 12_000;

function timestamp(now) {
  return new Date(now).toISOString();
}

export function unconfirmedCategory(reason, now = Date.now()) {
  return {
    status: "needs_confirmation", reason, middle: "", small: "", paths: [],
    sampleSize: 0, categorizedCount: 0, source: "", checkedAt: timestamp(now),
  };
}

function categoryName(value) {
  if (typeof value !== "string" || value.length > 100 || /[<>\u0000-\u001f\u007f]/u.test(value)) return "";
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

// Categories describe this keyword's observed product sample, never the seed's
// category or a product relationship/rank. Incomplete samples cannot be single.
export function categoriesFromSample(payload, keyword, now = Date.now()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.schemaVersion !== CATEGORY_SAMPLE_SCHEMA || ![CATEGORY_SAMPLE_SOURCE, COMMERCE_CATEGORY_SAMPLE_SOURCE].includes(payload.source)) {
    return unconfirmedCategory("source_mismatch", now);
  }
  if (relatedKeywordKey(payload.keyword) !== relatedKeywordKey(keyword)) return unconfirmedCategory("keyword_mismatch", now);
  const collectedAt = Date.parse(payload.collectedAt);
  if (!Number.isFinite(collectedAt) || collectedAt > now + 60_000 || now - collectedAt > SUCCESS_TTL_MS) {
    return unconfirmedCategory("stale_source", now);
  }
  if (!Array.isArray(payload.items) || payload.items.length > MAX_SAMPLE_SIZE) return unconfirmedCategory("invalid_sample", now);
  const catalog = payload.source === COMMERCE_CATEGORY_SAMPLE_SOURCE;
  if (catalog && (payload.sampleLimit !== MAX_SAMPLE_SIZE || typeof payload.hasMore !== "boolean"
    || !Number.isSafeInteger(payload.totalElements) || payload.totalElements < payload.items.length)) return unconfirmedCategory("invalid_sample", now);
  if (!payload.items.length) return unconfirmedCategory(catalog ? "no_catalog_results" : payload.complete === true ? "no_results" : "incomplete_sample", now);
  const counts = new Map();
  const productIds = new Set();
  let categorizedCount = 0;
  for (const item of payload.items) {
    const identity = catalog ? item?.catalogId : item?.productId;
    const validId = typeof identity === "string" && (catalog ? /^[1-9]\d{0,23}$/u : /^\d{5,24}$/u).test(identity);
    if (!validId || productIds.has(identity) || (catalog && (typeof item?.categoryId !== "string" || !/^[1-9]\d{0,23}$/u.test(item.categoryId)))) return unconfirmedCategory("invalid_sample", now);
    productIds.add(identity);
    const middle = categoryName(item?.category2);
    const small = categoryName(item?.category3);
    if (!middle || !small) continue;
    categorizedCount += 1;
    const key = JSON.stringify([middle, small]);
    const entry = counts.get(key) || { middle, small, sampleCount: 0 };
    entry.sampleCount += 1;
    counts.set(key, entry);
  }
  const paths = [...counts.values()].sort((a, b) => b.sampleCount - a.sampleCount || a.middle.localeCompare(b.middle, "ko") || a.small.localeCompare(b.small, "ko"));
  const complete = payload.complete === true && categorizedCount === payload.items.length;
  const status = paths.length > 1 ? "multiple" : paths.length === 1 && complete ? "single" : "needs_confirmation";
  const reason = !paths.length ? "missing_categories" : !complete ? "incomplete_sample" : paths.length > 1 ? "multiple_categories" : "sample_consistent";
  return {
    status, reason,
    middle: status === "single" ? paths[0].middle : "",
    small: status === "single" ? paths[0].small : "",
    paths, sampleSize: payload.items.length, categorizedCount,
    source: payload.source, checkedAt: timestamp(collectedAt),
    ...(catalog ? { basis: "catalog_search", sampleLimit: MAX_SAMPLE_SIZE, hasMore: payload.hasMore, totalElements: payload.totalElements } : {}),
  };
}

function providerConfig(env) {
  const mode = String(env.NAVER_KEYWORD_CATEGORY_SOURCE || "").trim();
  if (mode === "commerce") return hasCommerceCategoryConfig(env) ? { mode, key: "commerce:" + commerceCategoryCredentialKey(env) } : null;
  if (mode && mode !== "collector") return null;
  const rawUrl = String(env.NAVER_KEYWORD_CATEGORY_COLLECTOR_URL || "").trim();
  const token = String(env.NAVER_KEYWORD_CATEGORY_COLLECTOR_TOKEN || "").trim();
  if (!rawUrl || !token) return null;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search
      || isIP(host.replace(/^\[|\]$/gu, "")) || host === "localhost" || !host.includes(".")
      || /(?:\.localhost|\.local|\.internal)$/u.test(host) || /[\r\n]/u.test(token)) return null;
    // Keep the entire protected collector host isolated, including canonical
    // URL aliases, alternate ports and paths on the same service.
    const rankUrl = String(env.NAVER_SHOPPING_RANK_API_URL || "").trim();
    let rankHost = "";
    try { rankHost = rankUrl ? new URL(rankUrl).hostname.toLowerCase().replace(/\.+$/u, "") : ""; } catch { /* An invalid rank URL is not a category source. */ }
    if (host === rankHost || host === "openapi.naver.com" || host === "naverapihub.apigw.ntruss.com") return null;
    return { url: url.href, token, key: crypto.createHash("sha256").update(`${url.href}\n${token}`).digest("hex") };
  } catch { return null; }
}

export function createCategoryLookup({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const commerceSource = createCommerceCategorySource({ env, fetchImpl, now });
  const cache = new Map();
  const pending = new Map();
  const attempts = [];
  let cooldownUntil = 0;

  function remember(key, category) {
    const at = now();
    for (const [entryKey, entry] of cache) if (entry.expiresAt <= at) cache.delete(entryKey);
    if (cache.size >= MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
    const ttl = category.status === "needs_confirmation" ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
    const evidenceExpiresAt = Date.parse(category.checkedAt) + SUCCESS_TTL_MS;
    cache.set(key, { category, expiresAt: Math.min(at + ttl, evidenceExpiresAt) });
  }

  async function one(keyword, config, deadline, budget) {
    const at = now();
    const key = `${config.key}:${relatedKeywordKey(keyword)}`;
    const hit = cache.get(key);
    if (hit?.expiresAt > at) return hit.category;
    if (pending.has(key)) return pending.get(key);
    if (budget.exhausted || at >= deadline) return unconfirmedCategory("deadline_exceeded", at);
    if (at < cooldownUntil) return unconfirmedCategory("source_cooldown", at);
    while (attempts.length && at - attempts[0] >= RATE_WINDOW_MS) attempts.shift();
    if (attempts.length >= RATE_LIMIT) return unconfirmedCategory("rate_limited", at);
    if (pending.size >= MAX_CONCURRENCY) return unconfirmedCategory("source_busy", at);
    attempts.push(at);
    const work = (async () => {
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            // Timers can fire just before Date.now() reaches the boundary.
            // Exhaust this batch explicitly when its remaining budget timed out.
            if (deadline - at <= TIMEOUT_MS) budget.exhausted = true;
            controller.abort();
            reject(new Error("source_timeout"));
          }, Math.max(1, Math.min(TIMEOUT_MS, deadline - at)));
        });
        const request = (async () => {
          if (config.mode === "commerce") {
            const sample = await commerceSource(keyword, { deadline, signal: controller.signal });
            if (sample?.source !== COMMERCE_CATEGORY_SAMPLE_SOURCE) return unconfirmedCategory("source_mismatch", now());
            return categoriesFromSample(sample, keyword, now());
          }
          const url = new URL(config.url);
          url.searchParams.set("keyword", keyword);
          url.searchParams.set("limit", String(MAX_SAMPLE_SIZE));
          const response = await fetchImpl(url.href, {
            method: "GET", headers: { accept: "application/json", authorization: `Bearer ${config.token}` },
            signal: controller.signal, redirect: "error",
          });
          if (!response.ok) {
            if ([403, 418, 429].includes(response.status)) cooldownUntil = Math.max(cooldownUntil, now() + RATE_WINDOW_MS);
            await response.body?.cancel().catch(() => {});
            throw new Error(response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "source_permission" : "source_unavailable");
          }
          const sample = await readBoundedJson(response);
          if (sample?.source !== CATEGORY_SAMPLE_SOURCE) return unconfirmedCategory("source_mismatch", now());
          return categoriesFromSample(sample, keyword, now());
        })();
        const category = await Promise.race([request, timeout]);
        remember(key, category);
        return category;
      } catch (error) {
        if (["source_permission", "rate_limited", "source_cooldown"].includes(error?.message)) cooldownUntil = Math.max(cooldownUntil, now() + RATE_WINDOW_MS);
        const allowed = new Set(["source_timeout", "rate_limited", "source_permission", "source_unavailable", "response_too_large", "invalid_response", "invalid_sample", "source_config_invalid", "source_cooldown", "source_aborted", "deadline_exceeded"]);
        const category = unconfirmedCategory(allowed.has(error?.message) ? error.message : "source_unavailable", now());
        remember(key, category);
        return category;
      } finally { clearTimeout(timer); }
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }

  return async function lookupCategories(keywords, { deadline = now() + BATCH_TIMEOUT_MS } = {}) {
    const config = providerConfig(env);
    const values = [...new Map((Array.isArray(keywords) ? keywords : []).map((value) => {
      const keyword = normalizeRelatedKeyword(value);
      return [relatedKeywordKey(keyword), keyword];
    }).filter(([key]) => key)).values()].slice(0, MAX_KEYWORDS);
    if (!config) return values.map((keyword) => ({ keyword, category: unconfirmedCategory("source_unavailable", now()) }));
    const results = new Array(values.length);
    const budget = { exhausted: false };
    let next = 0;
    async function worker() {
      while (next < values.length) {
        const index = next++;
        const keyword = values[index];
        results[index] = { keyword, category: await one(keyword, config, deadline, budget) };
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, values.length) }, worker));
    return results;
  };
}

export const lookupRelatedKeywordCategories = createCategoryLookup();

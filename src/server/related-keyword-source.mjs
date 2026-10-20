import crypto from "node:crypto";

import { readBoundedJson, relatedKeywordKey } from "./category-source-utils.mjs";

const SEARCHAD_URL = "https://api.searchad.naver.com/keywordstool";
const MAX_KEYWORDS = 50;
const MAX_CACHE_SIZE = 256;
const TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 24 * 60 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 6;
const exactKeyword = (value) => typeof value === "string" ? value.normalize("NFC").trim() : "";

function finiteNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).replace(/,/gu, "").trim();
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function searchCount(value) {
  const text = typeof value === "string" ? value.replace(/,/gu, "").trim() : "";
  const threshold = text.match(/^<\s*(\d+)$/u);
  if (threshold && Number(threshold[1]) > 0) return { value: null, upper: Number(threshold[1]), label: `< ${Number(threshold[1]).toLocaleString("ko-KR")}` };
  const number = finiteNumber(value);
  if (number === null || !Number.isInteger(number)) return { value: null, upper: null, label: "확인 필요" };
  return { value: number, upper: null, label: number.toLocaleString("ko-KR") };
}

function combinedVolume(pc, mobile) {
  if (pc.value !== null && mobile.value !== null) {
    const volume = pc.value + mobile.value;
    return { volume, volumeLabel: volume.toLocaleString("ko-KR") };
  }
  if ((pc.value !== null || pc.upper !== null) && (mobile.value !== null || mobile.upper !== null)) {
    const upper = (pc.value ?? pc.upper) + (mobile.value ?? mobile.upper);
    return { volume: null, volumeLabel: `< ${upper.toLocaleString("ko-KR")}` };
  }
  return { volume: null, volumeLabel: "확인 필요" };
}

function weightedCtr(pcClicks, pcCtr, mobileClicks, mobileCtr) {
  if ([pcClicks, pcCtr, mobileClicks, mobileCtr].some((value) => value === null)) return null;
  if ((pcClicks > 0 && pcCtr <= 0) || (mobileClicks > 0 && mobileCtr <= 0)) return null;
  const impressions = (pcCtr > 0 ? pcClicks / (pcCtr / 100) : 0) + (mobileCtr > 0 ? mobileClicks / (mobileCtr / 100) : 0);
  return impressions > 0 ? Math.round(((pcClicks + mobileClicks) / impressions) * 10000) / 100 : null;
}

export function relatedRowsFromSearchAd(payload, seed) {
  if (!payload || !Array.isArray(payload.keywordList)) throw new Error("invalid_response");
  const seen = new Set([relatedKeywordKey(seed)]);
  const rows = [];
  for (const item of payload.keywordList) {
    const keyword = exactKeyword(item?.relKeyword);
    if (!keyword || keyword.length > 60 || /[\u0000-\u001f\u007f]/u.test(keyword)) continue;
    const key = relatedKeywordKey(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const pc = searchCount(item.monthlyPcQcCnt);
    const mobile = searchCount(item.monthlyMobileQcCnt);
    const pcClicks = finiteNumber(item.monthlyAvePcClkCnt);
    const mobileClicks = finiteNumber(item.monthlyAveMobileClkCnt);
    rows.push({
      keyword, ...combinedVolume(pc, mobile),
      pcVolume: pc.value, mobileVolume: mobile.value, pcVolumeLabel: pc.label, mobileVolumeLabel: mobile.label,
      clicks: pcClicks !== null && mobileClicks !== null ? Math.round((pcClicks + mobileClicks) * 10) / 10 : null,
      ctr: weightedCtr(pcClicks, finiteNumber(item.monthlyAvePcCtr), mobileClicks, finiteNumber(item.monthlyAveMobileCtr)),
      competition: typeof item.compIdx === "string" ? item.compIdx.trim().slice(0, 20) : "",
    });
    if (rows.length === MAX_KEYWORDS) break;
  }
  return rows;
}

// Each factory owns its source cache and local budget. Public/private callers do
// not share state; the optional hook may enforce an additional external budget.
export function createRelatedKeywordSource({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, beforeSourceFetch = async () => {} } = {}) {
  const cache = new Map();
  const pending = new Map();
  const attempts = [];
  let cooldownUntil = 0;

  return async function loadRows(keyword) {
    const apiKey = String(env.NAVER_SEARCHAD_API_KEY || "").trim();
    const secret = String(env.NAVER_SEARCHAD_SECRET_KEY || "").trim();
    const customer = String(env.NAVER_SEARCHAD_CUSTOMER_ID || "").trim();
    if (!apiKey || !secret || !customer) throw new Error("source_unavailable");
    const scope = crypto.createHash("sha256").update(`${apiKey}\n${secret}\n${customer}`).digest("hex");
    const key = `${scope}:${relatedKeywordKey(keyword)}`;
    const at = now();
    const hit = cache.get(key);
    if (hit?.expiresAt > at) return hit.rows;
    if (pending.has(key)) return pending.get(key);
    if (at < cooldownUntil) throw new Error("source_cooldown");
    while (attempts.length && at - attempts[0] >= RATE_WINDOW_MS) attempts.shift();
    if (attempts.length >= RATE_LIMIT || pending.size >= 2) throw new Error("rate_limited");
    attempts.push(at);
    // Defer the hook until after pending.set: even a reentrant hook observes the
    // reserved key and slot, so async admission cannot race or duplicate a fetch.
    const work = Promise.resolve().then(async () => {
      await beforeSourceFetch();
      const timestamp = String(at);
      const url = new URL(SEARCHAD_URL);
      url.searchParams.set("hintKeywords", keyword.replace(/\s+/gu, ""));
      url.searchParams.set("showDetail", "1");
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("source_timeout")); }, TIMEOUT_MS);
        });
        const request = (async () => {
          const response = await fetchImpl(url.href, {
            method: "GET", redirect: "error", signal: controller.signal,
            headers: {
              "X-Timestamp": timestamp, "X-API-KEY": apiKey, "X-Customer": customer,
              "X-Signature": crypto.createHmac("sha256", secret).update(`${timestamp}.GET./keywordstool`).digest("base64"),
            },
          });
          if (!response.ok) {
            if ([403, 418, 429].includes(response.status)) cooldownUntil = Math.max(cooldownUntil, now() + RATE_WINDOW_MS);
            await response.body?.cancel().catch(() => {});
            throw new Error(response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "source_permission" : "source_unavailable");
          }
          return relatedRowsFromSearchAd(await readBoundedJson(response, 2 * 1024 * 1024), keyword);
        })();
        const rows = await Promise.race([request, timeout]);
        for (const [entryKey, entry] of cache) if (entry.expiresAt <= now()) cache.delete(entryKey);
        if (cache.size >= MAX_CACHE_SIZE) cache.delete(cache.keys().next().value);
        cache.set(key, { rows, expiresAt: now() + CACHE_TTL_MS });
        return rows;
      } finally { clearTimeout(timer); }
    });
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
}

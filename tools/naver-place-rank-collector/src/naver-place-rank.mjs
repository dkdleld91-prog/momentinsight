const DEFAULT_MAX_RANK = 300;
const DEFAULT_TIMEOUT_MS = Number(process.env.NAVER_PLACE_PROVIDER_TIMEOUT_MS || 30000);
const DEFAULT_MAX_SCROLLS = Number(process.env.NAVER_PLACE_PROVIDER_MAX_SCROLLS || 8);
const HEADLESS = String(process.env.NAVER_PLACE_PROVIDER_HEADLESS || "true") !== "false";

function normalizeText(value) {
  return String(value || "").normalize("NFKC").trim();
}

function normalizeComparable(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()[\]{}'"`‘’“”·|:,._-]/g, "");
}

function clampMaxRank(value) {
  const number = Number(value || DEFAULT_MAX_RANK);
  if (!Number.isFinite(number)) return DEFAULT_MAX_RANK;
  return Math.max(20, Math.min(1000, Math.round(number)));
}

function extractPlaceId(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const direct = text.match(/^\d{5,}$/);
  if (direct) return direct[0];
  const patterns = [
    /\/place\/(\d+)/i,
    /\/(?:restaurant|hospital|accommodation|hairshop|beauty|attraction)\/(\d+)/i,
    /[?&]placeId=(\d+)/i,
    /[?&]id=(\d+)/i,
    /place%2F(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function normalizeUrl(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(naver\.me|map\.naver\.com|m\.place\.naver\.com|place\.naver\.com)\//i.test(text)) {
    return "https://" + text;
  }
  return text;
}

async function resolvePlaceUrl(value) {
  const originalUrl = normalizeUrl(value);
  const result = { url: originalUrl, placeId: extractPlaceId(originalUrl) };
  if (!/^https?:\/\//i.test(originalUrl)) return result;

  try {
    const response = await fetch(originalUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    result.url = normalizeText(response.url) || originalUrl;
    result.placeId = result.placeId || extractPlaceId(result.url);
  } catch {
    return result;
  }
  return result;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("playwright_not_installed");
  }
}

function uniqueCandidates(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.id || normalizeComparable(item.name + item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function collectCandidatesFromPage(page, keyword, maxRank) {
  const searchUrl = "https://m.map.naver.com/search?query=" + encodeURIComponent(keyword);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  await page.waitForTimeout(1800);

  let previousCount = 0;
  let stableCount = 0;
  for (let scroll = 0; scroll < DEFAULT_MAX_SCROLLS; scroll += 1) {
    const count = await page.locator("li[class*='_list_item_'], a[href*='m.place.naver.com/place/']").count().catch(() => 0);
    if (count >= maxRank) break;
    stableCount = count === previousCount ? stableCount + 1 : 0;
    if (stableCount >= 2) break;
    previousCount = count;
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(900);
  }

  const rawItems = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("li[class*='_list_item_']"));
    const cardItems = cards.map((card) => {
      const anchor = card.querySelector("a[href*='m.place.naver.com/place/'], a[href*='/place/']");
      const nameNode = card.querySelector("strong[class*='_item_name_'], strong");
      const href = anchor?.href || anchor?.getAttribute("href") || "";
      const text = (card.innerText || anchor?.innerText || "").replace(/\s+/g, " ").trim();
      const name = (nameNode?.innerText || anchor?.innerText || text.split(" ")[0] || "").replace(/\s+/g, " ").trim();
      return { href, name, text };
    });

    if (cardItems.length) return cardItems;

    const anchors = Array.from(document.querySelectorAll("a[href*='m.place.naver.com/place/'], a[href*='/place/']"));
    return anchors.map((anchor) => {
      const href = anchor.href || anchor.getAttribute("href") || "";
      const card = anchor.closest("li, article") || anchor;
      const text = (card.innerText || anchor.innerText || "").replace(/\s+/g, " ").trim();
      const name = (card.querySelector("strong")?.innerText || anchor.innerText || text.split(" ")[0] || "").replace(/\s+/g, " ").trim();
      return { href, name, text };
    });
  });

  return uniqueCandidates(rawItems.map((item) => {
    const id = extractPlaceId(item.href);
    const name = normalizeText(item.name || item.text.split(" ")[0] || "");
    return {
      rank: 0,
      id,
      name,
      url: item.href,
      text: item.text,
    };
  }).filter((item) => item.id || item.name))
    .slice(0, maxRank)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

async function collectCandidatesWithBrowser(keyword, maxRank) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    const context = await browser.newContext({
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    return await collectCandidatesFromPage(page, keyword, maxRank);
  } finally {
    await browser.close().catch(() => {});
  }
}

function findMatch(candidates, target) {
  const targetId = normalizeText(target.placeId);
  const targetName = normalizeComparable(target.placeName);
  const targetUrlId = extractPlaceId(target.placeUrl);
  const id = targetId || targetUrlId;

  if (id) {
    const byId = candidates.find((item) => normalizeText(item.id) === id || extractPlaceId(item.url) === id);
    if (byId) return byId;
  }

  if (targetName) {
    const byName = candidates.find((item) => {
      const name = normalizeComparable(item.name);
      const text = normalizeComparable(item.text);
      return name === targetName || text.includes(targetName) || targetName.includes(name);
    });
    if (byName) return byName;
  }

  return null;
}

export async function lookupNaverPlaceRank(payload = {}) {
  const keyword = normalizeText(payload.keyword);
  const maxRank = clampMaxRank(payload.maxRank || payload.max_rank);
  const placeUrl = normalizeUrl(payload.placeUrl || payload.place_url);
  const placeName = normalizeText(payload.placeName || payload.place_name);
  let placeId = normalizeText(payload.placeId || payload.place_id);

  if (!keyword) {
    return { ok: false, matched: false, message: "keyword_required" };
  }

  const resolved = await resolvePlaceUrl(placeUrl);
  placeId = placeId || resolved.placeId;

  if (!placeId && !placeName) {
    return {
      ok: false,
      matched: false,
      checkedCount: 0,
      total: 0,
      message: "플레이스 URL에서 ID를 확인하지 못했습니다. 상호명 또는 정식 플레이스 URL이 필요합니다.",
      source: "naver_place_browser_collector",
    };
  }

  const candidates = await collectCandidatesWithBrowser(keyword, maxRank);
  const matched = findMatch(candidates, {
    placeId,
    placeUrl: resolved.url || placeUrl,
    placeName,
  });

  return {
    ok: true,
    matched: Boolean(matched),
    rank: matched ? matched.rank : null,
    checkedCount: candidates.length,
    total: candidates.length,
    place: matched || {
      id: placeId,
      name: placeName,
      url: resolved.url || placeUrl,
    },
    topPlaces: candidates.slice(0, 20),
    source: "naver_place_browser_collector",
    message: matched
      ? "네이버 플레이스 오가닉 " + matched.rank + "위로 확인되었습니다."
      : "상위 " + candidates.length + "개 안에서 대상 플레이스를 찾지 못했습니다.",
  };
}

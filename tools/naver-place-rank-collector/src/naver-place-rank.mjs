const DEFAULT_MAX_RANK = 300;
const DEFAULT_TIMEOUT_MS = Number(process.env.NAVER_PLACE_PROVIDER_TIMEOUT_MS || 90000);
const DEFAULT_MAX_SCROLLS = Number(process.env.NAVER_PLACE_PROVIDER_MAX_SCROLLS || 90);
const HEADLESS = String(process.env.NAVER_PLACE_PROVIDER_HEADLESS || "true") !== "false";

const NAVER_MAP_SEARCH_BASE = "https://map.naver.com/p/search/";
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

function clampMaxRank(value) {
  const number = Number(value || DEFAULT_MAX_RANK);
  if (!Number.isFinite(number)) return DEFAULT_MAX_RANK;
  return Math.max(20, Math.min(1000, Math.round(number)));
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
      const text = (row.innerText || "").replace(/\s+/g, " ").trim();
      const nameNodes = Array.from(row.querySelectorAll("span, strong, a, div"))
        .map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const anchor = row.querySelector("a[href*='/place/'], a[href*='/restaurant/'], a[href*='/entry/place/']");
      const hrefs = Array.from(row.querySelectorAll("a[href]"))
        .map((node) => node.href || node.getAttribute("href") || "")
        .filter(Boolean);
      const adLink = row.querySelector("a[href*='help.naver.com/support/alias/NSP/NSP_53']");
      const url = anchor?.href || anchor?.getAttribute("href") || "";
      const aria = row.getAttribute("aria-label") || "";
      return {
        visibleIndex,
        text,
        aria,
        url,
        hrefs,
        html: (row.outerHTML || "").slice(0, 12000),
        isAd: Boolean(adLink) || /\b광고\b/.test(text),
        nameNodes: nameNodes.slice(0, 12),
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
  if (!rawRow || rawRow.isAd) return;
  const name = rowNameFromRaw(rawRow);
  if (!isLikelyPlaceName(name)) return;

  const placeIds = collectCandidateIds(rawRow);
  const id = placeIds[0] || "";
  const key = placeIds.length ? placeIds.join("|") : normalizeComparable(name + normalizeText(rawRow.text).slice(0, 80));
  if (!key || items.some((item) => item.key === key)) return;

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
    isAd: false,
  });
}

async function scrollListFrame(frame) {
  return await frame.evaluate(() => {
    const root = document.querySelector("#_pcmap_list_scroll_container");
    if (!root) {
      window.scrollBy(0, Math.max(700, window.innerHeight * 0.85));
      return { scrollTop: window.scrollY, scrollHeight: document.body.scrollHeight };
    }
    root.scrollTop += Math.max(680, root.clientHeight * 0.85);
    root.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { scrollTop: root.scrollTop, scrollHeight: root.scrollHeight };
  });
}

async function collectCandidatesFromNaverMap(context, keyword, maxRank) {
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    const searchUrl = NAVER_MAP_SEARCH_BASE + encodeURIComponent(keyword);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    const frame = await waitForListFrame(page);
    await frame.waitForSelector("#_pcmap_list_scroll_container li, li", { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1200);

    const candidates = [];
    let stableCount = 0;
    let previousCount = 0;
    let previousScrollTop = -1;

    for (let scroll = 0; scroll <= DEFAULT_MAX_SCROLLS; scroll += 1) {
      const visibleRows = await extractVisibleRows(frame);
      visibleRows.forEach((row) => appendCandidate(candidates, row));

      if (candidates.length >= maxRank) break;
      const scrollState = await scrollListFrame(frame);
      await page.waitForTimeout(850);

      const noGrowth = candidates.length === previousCount;
      const noScroll = Number(scrollState.scrollTop) === previousScrollTop;
      stableCount = noGrowth && noScroll ? stableCount + 1 : 0;
      if (stableCount >= 3) break;
      previousCount = candidates.length;
      previousScrollTop = Number(scrollState.scrollTop);
    }

    return candidates.slice(0, maxRank).map(({ key: _key, ...item }, index) => ({
      ...item,
      rank: index + 1,
    }));
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

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    const context = await browser.newContext({
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    });

    const resolved = placeUrl ? await resolvePlaceIdentityWithBrowser(context, placeUrl) : { url: placeUrl, placeId: "", placeIds: [], placeName: "" };
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

    const candidates = await collectCandidatesFromNaverMap(context, keyword, maxRank);
    let matched = findMatch(candidates, {
      placeId,
      placeIds,
      placeUrl: resolved.url || placeUrl,
      placeName,
    });

    if (!matched && (placeIds.length || placeName)) {
      matched = await findVerifiedMatchByClick(context, keyword, {
        placeId,
        placeIds,
        placeUrl: resolved.url || placeUrl,
        placeName,
      }, maxRank);
    }

    const place = matched || {
      id: placeId,
      name: placeName,
      url: resolved.url || placeUrl,
    };

    return {
      ok: true,
      matched: Boolean(matched),
      rank: matched ? matched.rank : null,
      checkedCount: candidates.length,
      total: candidates.length,
      place,
      topPlaces: candidates.slice(0, 20),
      source: "naver_map_browser_collector",
      message: matched
        ? "네이버 지도 오가닉 " + matched.rank + "위로 확인되었습니다."
        : "네이버 지도 오가닉 상위 " + candidates.length + "개 안에서 대상 플레이스를 찾지 못했습니다.",
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

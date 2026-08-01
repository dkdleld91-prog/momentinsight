const PROBE_KEY_SHA256 = "aacc13b5929f5fc3d72838caade3128dc04e36af5f152ea25958a85cb06ae190";
const KEYWORD = "온열찜질기";
const STATE_MARKER = 'naver.search.ext.newshopping["shopping"]._INITIAL_STATE=';

export const config = {
  runtime: "edge",
  regions: ["icn1"],
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function extractState(html) {
  const markerAt = html.indexOf(STATE_MARKER);
  if (markerAt < 0) throw new Error("state_marker_missing");
  const start = markerAt + STATE_MARKER.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(html.slice(start, index + 1)
          .replace(/\bundefined\b/g, "null")
          .replace(/new Date\(("(?:[^"\\]|\\.)*")\)/g, "$1"));
      }
    }
  }
  throw new Error("state_unterminated");
}

function flattenSlotData(page) {
  return (Array.isArray(page?.slots) ? page.slots : []).flatMap((slot) => (
    Array.isArray(slot?.data) ? slot.data : (slot?.data ? [slot.data] : [])
  ));
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ ok: false, code: "METHOD_NOT_ALLOWED" }, 405);
  if (await sha256(request.headers.get("x-mi-probe-key") || "") !== PROBE_KEY_SHA256) {
    return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  }

  const mobileUa = "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const bootstrapUrl = new URL("https://m.search.naver.com/search.naver");
    bootstrapUrl.searchParams.set("where", "m");
    bootstrapUrl.searchParams.set("query", KEYWORD);
    const bootstrap = await fetch(bootstrapUrl, {
      signal: controller.signal,
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "ko-KR,ko;q=0.9", "user-agent": mobileUa },
    });
    const html = await bootstrap.text();
    if (bootstrap.status !== 200) {
      return json({ ok: false, phase: "bootstrap", bootstrapStatus: bootstrap.status, marker: html.includes(STATE_MARKER) });
    }
    const state = extractState(html);
    const init = state?.initProps || {};
    const initialPages = Array.isArray(init.pagedSlot) ? init.pagedSlot : [];
    const params = {
      ...(init.byPassBFFParams || {}),
      isFastDelivery: false,
      isArriveGuarantee: false,
      query: state.query || state.originQuery || KEYWORD,
      source: state.areaCode || "shp_tli",
      page: 6,
      pageSize: Number(initialPages[0]?.pageSize || 9),
    };
    const bffUrl = new URL("https://ns-portal.shopping.naver.com/api/v2/shopping-paged-slot");
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      bffUrl.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const bff = await fetch(bffUrl, {
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "ko-KR,ko;q=0.9",
        referer: bootstrap.url,
        "user-agent": mobileUa,
        "x-ns-rev": String(state.rev || "4"),
        "x-ns-page-id": String(state.pageId || ""),
        "x-ns-session-id": String(state.sessionId || ""),
        "x-ns-device-type": String(state.device?.type || "mobile"),
        "x-ns-view-type": String(state.viewType || "GUIDE"),
      },
    });
    const body = await bff.text();
    let payload = null;
    try { payload = JSON.parse(body); } catch {}
    const pages = Array.isArray(payload?.data) ? payload.data : [];
    const organic = pages.flatMap(flattenSlotData).filter((item) => item?.sourceType === "SAS");
    const ranks = [...new Set(organic.map((item) => Number(item?.rank)).filter(Number.isInteger))].sort((a, b) => a - b);
    const contiguous = ranks.length > 0 && ranks.every((rank, index) => rank === index + 1);
    return json({
      ok: bootstrap.status === 200 && bff.status === 200 && contiguous,
      bootstrapStatus: bootstrap.status,
      marker: html.includes(STATE_MARKER),
      bffStatus: bff.status,
      bffJson: Boolean(payload),
      pageCount: pages.length,
      organicCount: ranks.length,
      firstRank: ranks[0] || null,
      lastRank: ranks.at(-1) || null,
      contiguous,
    });
  } catch (error) {
    return json({ ok: false, code: error?.name === "AbortError" ? "UPSTREAM_TIMEOUT" : String(error?.message || "UPSTREAM_FAILED").slice(0, 80) }, 502);
  } finally {
    clearTimeout(timeout);
  }
}

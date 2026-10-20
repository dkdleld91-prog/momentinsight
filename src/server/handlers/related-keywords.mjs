import { normalizeRelatedKeyword, unconfirmedCategory } from "../related-keyword-categories.mjs";
import { createRelatedKeywordSource } from "../related-keyword-source.mjs";
import { createStoredRankCategoryLookup, storedKeywordKey } from "../stored-rank-keyword-categories.mjs";

export { relatedRowsFromSearchAd } from "../related-keyword-source.mjs";

const TOTAL_TIMEOUT_MS = 16_000;
const SOURCE = "naver_searchad_keywordstool";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function createRelatedKeywordsHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, lookupCategories = createStoredRankCategoryLookup({ env, fetchImpl, now }) } = {}) {
  const loadRows = createRelatedKeywordSource({ env, fetchImpl, now });

  return async function handleRelatedKeywords(request) {
    if (request.method !== "GET") return json({ ok: false, reason: "method_not_allowed", message: "GET 요청만 가능합니다." }, 405);
    if (!String(request.headers.get("x-mi-session-role") || "").trim()) return json({ ok: false, reason: "session_required", message: "로그인 후 조회해주세요." }, 401);
    const keyword = normalizeRelatedKeyword(new URL(request.url).searchParams.get("keyword"));
    if (!keyword) return json({ ok: false, reason: "keyword_required", message: "키워드를 입력해주세요." }, 400);
    const startedAt = now();
    try {
      const rows = await loadRows(keyword);
      const categoryRows = await lookupCategories(rows.map((row) => row.keyword), { request, deadline: startedAt + TOTAL_TIMEOUT_MS }).catch(() => []);
      const categories = new Map(categoryRows.map((row) => [storedKeywordKey(row.keyword), row.category]));
      return json({ ok: true, keyword, checkedAt: new Date(startedAt).toISOString(), source: SOURCE,
        related: rows.map((row) => ({ ...row, category: categories.get(storedKeywordKey(row.keyword)) || unconfirmedCategory("source_unavailable", now()) })),
      });
    } catch (error) {
      const reasons = new Set(["source_timeout", "source_permission", "source_cooldown", "rate_limited", "invalid_response", "response_too_large", "source_unavailable"]);
      const reason = reasons.has(error?.message) ? error.message : "source_unavailable";
      return json({ ok: false, keyword, reason, message: "연관 키워드를 불러오지 못했습니다. 잠시 후 다시 조회해주세요.", related: [] }, reason === "rate_limited" || reason === "source_cooldown" ? 429 : 503);
    }
  };
}

export const handleRelatedKeywordsRequest = createRelatedKeywordsHandler();

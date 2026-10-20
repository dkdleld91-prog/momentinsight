import crypto from "node:crypto";
import { isIP } from "node:net";
import { normalizeRelatedKeyword, readBoundedJson } from "./category-source-utils.mjs";
import { createRelatedKeywordSource } from "./related-keyword-source.mjs";

const RATE_TIMEOUT_MS = 1500;
const NAMESPACE = "public-related:v1";
export const PUBLIC_RELATED_LIMITS = Object.freeze({ ipMinute: 5, ipHour: 30, globalHour: 100, sourceMinute: 6 });
const serverSecret = env => String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

export class PublicRelatedLimitError extends Error {
  constructor(code, retryAfter = 60) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function response(body, status = 200, retryAfter) {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}),
  } });
}

export function publicRelatedRateKey(scope, ip, env = process.env) {
  if (scope.startsWith("ip-")) {
    const secret = serverSecret(env);
    if (!secret || !isIP(ip)) throw new PublicRelatedLimitError("rate_unavailable");
    return crypto.createHmac("sha256", secret).update(`${NAMESPACE}:${scope}\u0000${ip}`).digest("hex");
  }
  return crypto.createHash("sha256").update(`${NAMESPACE}:${scope}`).digest("hex");
}

export function createPublicRateConsumer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return async function consume(scope, ip, windowSeconds, limit) {
    const base = String(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL || "").trim().replace(/\/$/u, "");
    const secret = serverSecret(env);
    if (!base || !secret || base.includes("[SENSITIVE]") || secret.includes("[SENSITIVE]")) throw new PublicRelatedLimitError("rate_unavailable");
    let target;
    try {
      const origin = new URL(base);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("invalid_config");
      target = origin.origin + "/rest/v1/rpc/consume_code_login_rate_limit";
    } catch { throw new PublicRelatedLimitError("rate_unavailable"); }
    const keyHash = publicRelatedRateKey(scope, ip, env);
    const controller = new AbortController();
    let timer;
    try {
      const operation = (async () => {
        const headers = { "content-type": "application/json", apikey: secret };
        if (!secret.startsWith("sb_secret_")) headers.authorization = `Bearer ${secret}`;
        const result = await fetchImpl(target, { method: "POST", redirect: "error", signal: controller.signal,
          headers,
          body: JSON.stringify({ p_key_hash: keyHash, p_window_seconds: windowSeconds, p_attempt_limit: limit }),
        });
        if (!result.ok) { await result.body?.cancel().catch(() => {}); throw new Error("rate_unavailable"); }
        const rows = await readBoundedJson(result, 2048);
        if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0].allowed !== "boolean"
          || !Number.isInteger(rows[0].retry_after) || rows[0].retry_after < 0 || rows[0].retry_after > windowSeconds
          || (rows[0].allowed && rows[0].retry_after !== 0) || (!rows[0].allowed && rows[0].retry_after < 1)) throw new Error("rate_unavailable");
        return rows[0];
      })();
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("rate_unavailable")); }, RATE_TIMEOUT_MS); });
      const row = await Promise.race([operation, timeout]);
      if (!row.allowed) throw new PublicRelatedLimitError("rate_limited", row.retry_after);
    } catch (error) {
      if (error instanceof PublicRelatedLimitError) throw error;
      throw new PublicRelatedLimitError("rate_unavailable");
    } finally { clearTimeout(timer); }
  };
}

export function createPublicRelatedKeywordsHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now,
  consume = createPublicRateConsumer({ env, fetchImpl }), loadRows,
} = {}) {
  // A separate factory owns only public SearchAd cache/budget. No tenant lookup is imported here.
  const source = loadRows || createRelatedKeywordSource({ env, fetchImpl, now,
    beforeSourceFetch: () => consume("source-minute", "", 60, PUBLIC_RELATED_LIMITS.sourceMinute),
  });
  return async function handle(request, { clientIp = "" } = {}) {
    if (request.method !== "GET") return response({ ok: false, reason: "method_not_allowed", message: "GET 요청만 가능합니다." }, 405);
    const url = new URL(request.url);
    const raw = url.searchParams.getAll("keyword");
    if (raw.length !== 1 || raw[0].length > 360 || raw[0].normalize("NFC").replace(/\s+/gu, " ").trim().length > 60
      || /[\u0000-\u001f\u007f]/u.test(raw[0])) return response({ ok: false, reason: "keyword_required", message: "60자 이내의 키워드를 입력해주세요." }, 400);
    const keyword = normalizeRelatedKeyword(raw[0]);
    if (!keyword || !isIP(clientIp)) return response({ ok: false, reason: !keyword ? "keyword_required" : "rate_unavailable", message: !keyword ? "키워드를 입력해주세요." : "현재 조회를 처리하지 못했습니다. 잠시 후 다시 조회해주세요." }, !keyword ? 400 : 503);
    try {
      // Separate durable keys: exhausting public usage cannot lock a login or a rank operation.
      await consume("ip-minute", clientIp, 60, PUBLIC_RELATED_LIMITS.ipMinute);
      await consume("ip-hour", clientIp, 3600, PUBLIC_RELATED_LIMITS.ipHour);
      await consume("all-hour", "", 3600, PUBLIC_RELATED_LIMITS.globalHour);
      const startedAt = now();
      const rows = await source(keyword);
      // Fixed public fields only, even when a caller attaches cookies, roles or agency parameters.
      const fields = ["keyword", "volume", "volumeLabel", "pcVolume", "mobileVolume", "pcVolumeLabel", "mobileVolumeLabel", "clicks", "ctr", "competition"];
      return response({ ok: true, keyword, checkedAt: new Date(startedAt).toISOString(), source: "naver_searchad_keywordstool",
        related: rows.slice(0, 50).map(row => Object.fromEntries(fields.map(field => [field, row[field]]))),
      });
    } catch (error) {
      const limited = error instanceof PublicRelatedLimitError && error.code === "rate_limited"
        || ["rate_limited", "source_cooldown"].includes(error?.message);
      const retryAfter = error instanceof PublicRelatedLimitError ? error.retryAfter : 60;
      return response({ ok: false, keyword, reason: limited ? "rate_limited" : "source_unavailable", related: [],
        message: limited ? "조회 한도에 도달했습니다. 잠시 후 다시 조회해주세요." : "현재 조회를 처리하지 못했습니다. 잠시 후 다시 조회해주세요.",
      }, limited ? 429 : 503, retryAfter);
    }
  };
}

export const handlePublicRelatedKeywords = createPublicRelatedKeywordsHandler();

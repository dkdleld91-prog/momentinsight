import crypto from "node:crypto";
import { withSupabase } from "@supabase/server";

import { corsHeaders, protectedJson } from "../security.mjs";
import { requestShoppingWorkerWake } from "../naver-shopping/worker-wake.mjs";
import {
  extractProductId,
  normalizeText,
} from "./naver-shopping-rank.mjs";

const LOOKUP_LIMIT = 300;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NUMERIC_ID_PATTERN = /^[0-9]{5,}$/u;
const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/u;
const JOB_SELECT = [
  "id",
  "status",
  "checked_at",
  "result",
  "message",
  "error_code",
  "expires_at",
  "processing_until",
].join(", ");

function json(request, body, status = 200) {
  return protectedJson(request, body, status, {
    methods: "GET, POST, OPTIONS",
    headers: "content-type, x-mi-csrf",
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function bounded(value, maximum) {
  return normalizeText(value).slice(0, maximum);
}

function numericId(value) {
  const id = String(value || "").trim();
  return NUMERIC_ID_PATTERN.test(id) ? id : "";
}

function timestampElapsed(value, now = Date.now()) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) && timestamp <= now;
}

export function rankLookupScopeHash(request) {
  const role = String(request.headers.get("x-mi-session-role") || "").trim().toLowerCase();
  const agencyCode = String(request.headers.get("x-mi-agency-code") || "").trim().toLowerCase();
  const teamCode = String(request.headers.get("x-mi-team-code") || "").trim().toLowerCase();
  const ownerCode = String(request.headers.get("x-mi-owner-agency-code") || "").trim().toLowerCase();
  let scopeType = "";
  let scopeId = "";
  if (agencyCode) {
    scopeType = "agency";
    scopeId = agencyCode;
  } else if (role === "team" && teamCode) {
    scopeType = "team";
    scopeId = teamCode;
  } else if (role === "owner") {
    scopeType = "owner";
    scopeId = ownerCode || "primary";
  }
  if (!["owner", "team", "client"].includes(role) || !SCOPE_ID_PATTERN.test(scopeId)) return "";
  return sha256(`mi-rank-lookup-v1\n${scopeType}\n${scopeId}`);
}

function lookupRequest(body = {}) {
  const keyword = bounded(body.keyword, 100);
  const productUrl = bounded(body.targetUrl || body.productUrl, 1000);
  const productId = numericId(body.productId) || extractProductId(productUrl);
  const targetCatalogId = numericId(body.targetCatalogId);
  const mallName = bounded(body.mallName, 120);
  const productTitle = bounded(body.productTitle, 300);
  if (!keyword) return { error: "키워드를 입력해주세요." };
  if (!productUrl && !productId && !targetCatalogId) {
    return { error: "네이버 상품 URL 또는 상품ID를 입력해주세요." };
  }
  return {
    keyword,
    productUrl,
    productId,
    targetCatalogId,
    mallName,
    productTitle,
    maxRank: LOOKUP_LIMIT,
  };
}

function requestHash(query) {
  return sha256(JSON.stringify([
    query.keyword,
    query.productUrl,
    query.productId,
    query.targetCatalogId,
    query.mallName,
    query.productTitle,
    LOOKUP_LIMIT,
  ]));
}

async function enqueue(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(request, { ok: false, code: "RANK_LOOKUP_JSON_INVALID", message: "요청 내용을 확인해주세요." }, 400);
  }
  const scopeHash = rankLookupScopeHash(request);
  if (!scopeHash) return json(request, { ok: false, code: "RANK_LOOKUP_SCOPE_REQUIRED", message: "현재 계정 범위를 확인할 수 없습니다." }, 403);
  const query = lookupRequest(body);
  if (query.error) return json(request, { ok: false, code: "RANK_LOOKUP_INPUT_INVALID", message: query.error }, 400);

  const { data, error } = await ctx.supabaseAdmin.rpc("mi_enqueue_naver_shopping_rank_lookup_job", {
    p_scope_hash: scopeHash,
    p_request_hash: requestHash(query),
    p_keyword: query.keyword,
    p_product_url: query.productUrl || null,
    p_product_id: query.productId || null,
    p_target_catalog_id: query.targetCatalogId || null,
    p_mall_name: query.mallName || null,
    p_product_title: query.productTitle || null,
  });
  if (error) {
    if (/rank_lookup_queue_full/iu.test(error.message || "")) {
      return json(request, {
        ok: false,
        code: "RANK_LOOKUP_QUEUE_FULL",
        message: "현재 계정의 순위 조회가 처리 중입니다. 완료 후 다시 시도해주세요.",
      }, 429);
    }
    if (/schema cache|does not exist|mi_enqueue_naver_shopping_rank_lookup_job/iu.test(error.message || "")) {
      return json(request, {
        ok: false,
        code: "RANK_LOOKUP_QUEUE_NOT_READY",
        message: "단건 300위 조회 대기열을 준비하고 있습니다.",
      }, 503);
    }
    throw error;
  }
  const jobId = String(data?.id || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(jobId)) throw new Error("rank_lookup_enqueue_invalid");
  const remoteWakeRequested = await requestShoppingWorkerWake(ctx, "rank-lookup");
  return json(request, {
    ok: true,
    pending: true,
    remoteWakeRequested,
    jobId,
    status: String(data?.status || "pending"),
    deduplicated: data?.deduplicated === true,
    expiresAt: data?.expiresAt || null,
    retryAfter: 3,
    message: data?.deduplicated === true
      ? "진행 중인 같은 300위 조회를 이어서 확인합니다."
      : "중앙 Mac에 300위 전체 조회를 요청했습니다.",
  }, 202);
}

async function poll(request, ctx) {
  const scopeHash = rankLookupScopeHash(request);
  if (!scopeHash) return json(request, { ok: false, code: "RANK_LOOKUP_SCOPE_REQUIRED", message: "현재 계정 범위를 확인할 수 없습니다." }, 403);
  const jobId = String(new URL(request.url).searchParams.get("jobId") || "").trim().toLowerCase();
  if (!UUID_PATTERN.test(jobId)) return json(request, { ok: false, code: "RANK_LOOKUP_JOB_INVALID", message: "조회 작업 번호를 확인해주세요." }, 400);

  const { data, error } = await ctx.supabaseAdmin
    .from("naver_shopping_rank_lookup_jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .eq("scope_hash", scopeHash)
    .maybeSingle();
  if (error) {
    if (/schema cache|does not exist|naver_shopping_rank_lookup_jobs/iu.test(error.message || "")) {
      return json(request, { ok: false, code: "RANK_LOOKUP_QUEUE_NOT_READY", message: "단건 300위 조회 대기열을 준비하고 있습니다." }, 503);
    }
    throw error;
  }
  if (!data) return json(request, { ok: false, code: "RANK_LOOKUP_JOB_NOT_FOUND", message: "이 계정에서 조회 작업을 확인할 수 없습니다." }, 404);

  if (data.status === "completed" && data.result && typeof data.result === "object") {
    return json(request, {
      ok: true,
      pending: false,
      jobId,
      status: "completed",
      checkedAt: data.checked_at || data.result.checkedAt || null,
      ...data.result,
      message: data.message || data.result.message || "300위 전체 조회를 완료했습니다.",
    });
  }
  if (data.status === "failed" || data.status === "expired") {
    return json(request, {
      ok: false,
      pending: false,
      jobId,
      status: data.status,
      code: data.status === "expired" ? "RANK_LOOKUP_EXPIRED" : "RANK_LOOKUP_FAILED",
      message: data.status === "expired"
        ? "조회 대기 시간이 지나 종료되었습니다. 중앙 Mac 연결 후 다시 시도해주세요."
        : "300위 전체 조회를 완료하지 못했습니다. 잠시 후 다시 시도해주세요.",
    }, 503);
  }
  if (["pending", "processing"].includes(data.status) && timestampElapsed(data.expires_at)) {
    return json(request, {
      ok: false,
      pending: false,
      jobId,
      status: "expired",
      code: "RANK_LOOKUP_EXPIRED",
      message: "조회 대기 시간이 지나 종료되었습니다. 작업용 데스크탑 연결 상태를 확인한 뒤 다시 시도해주세요.",
    }, 503);
  }
  if (data.status === "processing" && timestampElapsed(data.processing_until)) {
    return json(request, {
      ok: false,
      pending: false,
      jobId,
      status: "failed",
      code: "RANK_LOOKUP_WORKER_STALLED",
      message: "순위 조회 작업의 응답 시간이 지나 종료되었습니다. 작업용 데스크탑 상태를 확인한 뒤 다시 시도해주세요.",
    }, 503);
  }
  return json(request, {
    ok: true,
    pending: true,
    jobId,
    status: data.status,
    retryAfter: 3,
    expiresAt: data.expires_at || null,
    message: data.status === "processing"
      ? "중앙 Mac이 오가닉 300위를 확인하고 있습니다."
      : "중앙 Mac 수집 대기열에 등록되었습니다.",
  }, 202);
}

export async function handleShoppingRankJobsRequest(request, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  try {
    if (request.method === "POST") return enqueue(request, ctx);
    if (request.method === "GET") return poll(request, ctx);
    return json(request, { ok: false, code: "METHOD_NOT_ALLOWED", message: "Method not allowed" }, 405);
  } catch (error) {
    return json(request, {
      ok: false,
      code: "RANK_LOOKUP_QUEUE_ERROR",
      message: "단건 300위 조회 대기열을 확인하지 못했습니다.",
      detail: process.env.NODE_ENV === "development" ? error?.message : undefined,
    }, 500);
  }
}

export default {
  fetch: withSupabase({ auth: "none" }, handleShoppingRankJobsRequest),
};

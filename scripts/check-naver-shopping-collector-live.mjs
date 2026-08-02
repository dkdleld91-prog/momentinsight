import fs from "node:fs";
import path from "node:path";

import {
  NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
  trustedCollectorWindow,
} from "../src/server/handlers/naver-shopping-rank.mjs";
import { collectMobileTopFallbackWindow } from "../src/server/naver-shopping/mobile-top-fallback.mjs";
import {
  isMobileTopFallbackMode,
  isHybridLocalWorkerMode,
  shoppingCollectorFailureStatus,
  shoppingRankConfig,
} from "../src/server/naver-shopping/source-status.mjs";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return acc;
      const index = trimmed.indexOf("=");
      if (index < 1) return acc;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      acc[key] = value;
      return acc;
    }, {});
}

function runtimeEnv() {
  const root = process.cwd();
  return {
    ...loadEnv(path.join(root, "05_네이버_API_연동", ".env.local")),
    ...loadEnv(path.join(root, "06_Supabase_연동", ".env.local")),
    ...loadEnv(path.join(root, ".env.local")),
    ...process.env,
  };
}

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerReason(payload, status) {
  return String(payload?.provider?.reason || payload?.reason || payload?.message || payload?.detail || `http_${status || 0}`)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 160) || "unknown";
}

function terminalReadinessFailure(reason) {
  return /^(?:naver_http_(?:403|418)|naver_captcha_detected|naver_auth_required|provider_browser_dependency_missing|provider_browser_launch_failed|verified_provider_not_configured|unsupported_provider_mode|canary_keyword_missing)$/u.test(reason);
}

async function waitForVerifiedReadiness(readyUrl, providerKey, timeoutMs = 110_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  let lastReason = "collector_starting";

  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(
        readyUrl,
        { headers: { accept: "application/json", authorization: `Bearer ${providerKey}` } },
        Math.min(5_000, Math.max(1, deadline - Date.now())),
      );
      const payload = await response.json().catch(() => null);
      lastStatus = response.status;
      lastReason = providerReason(payload, response.status);
      if (response.ok && payload?.ready === true && payload?.provider?.verified === true) {
        return payload;
      }
      if (terminalReadinessFailure(lastReason)) break;
    } catch (error) {
      lastReason = error?.name === "AbortError" ? "collector_starting" : "collector_unreachable";
    }
    await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
  }

  throw new Error(`collector_not_ready:${lastStatus}:${lastReason}`);
}

const env = runtimeEnv();
const vercelBuildMode = process.argv.includes("--vercel-build");
if (vercelBuildMode && env.VERCEL_ENV !== "production") {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "vercel_non_production_build",
    vercelEnv: String(env.VERCEL_ENV || "local"),
    checkedAt: new Date().toISOString(),
  }, null, 2));
  process.exit(0);
}
const shoppingRank = shoppingRankConfig(env);
const providerUrl = shoppingRank.providerUrl;
const providerKey = shoppingRank.providerKey;
const keyword = String(argValue("keyword", "온열찜질기")).trim();
const limit = Math.max(1, Math.min(300, Number(argValue("limit", "300")) || 300));
const startedAt = Date.now();

async function verifiedMobileFallbackEvidence() {
  const fallback = await collectMobileTopFallbackWindow(keyword, {
    timeoutMs: 6_000,
    cacheTtlMs: 30_000,
  });
  const ranks = fallback.items.map((item) => Number(item.organicRank));
  const increasing = ranks.length > 0 && ranks.every((rank, index) => (
    Number.isInteger(rank)
    && rank > 0
    && (index === 0 || rank > ranks[index - 1])
  ));
  const organicOnly = fallback.items.every((item) => (
    item?.sourceType === "SAS"
    && item?.isAd === false
    && item?.isOrganic === true
  ));
  const highestExactRank = ranks.at(-1) || 0;
  if (!increasing
    || !organicOnly
    || fallback.checkedCount !== fallback.items.length
    || fallback.checkedCount < 35
    || highestExactRank < 40) {
    throw new Error("mobile_top_fallback_untrusted_window");
  }
  return { fallback, ranks, organicOnly, highestExactRank };
}

async function verifiedHybridWorkerEvidence() {
  const supabaseUrl = String(env.SUPABASE_URL || "").trim();
  const serviceKey = String(env.SUPABASE_SECRET_KEY || "").trim();
  if (!supabaseUrl || !serviceKey) throw new Error("hybrid_worker_proof_database_missing");
  const url = new URL("/rest/v1/naver_rank_snapshots", supabaseUrl);
  url.searchParams.set("select", "checked_at,checked_count,source,collection_id");
  url.searchParams.set("collection_id", "like.pw-*");
  url.searchParams.set("checked_count", "eq.300");
  url.searchParams.set("order", "checked_at.desc");
  url.searchParams.set("limit", "1");
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: "application/json",
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
    },
  }, 8_000);
  if (!response.ok) throw new Error(`hybrid_worker_proof_http_${response.status}`);
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  const checkedAtMs = Date.parse(String(row?.checked_at || ""));
  const ageMs = Date.now() - checkedAtMs;
  if (!row
    || Number(row.checked_count) !== 300
    || !String(row.collection_id || "").startsWith("pw-")
    || !Number.isFinite(ageMs)
    || ageMs < 0
    || ageMs > 24 * 60 * 60_000) {
    throw new Error("hybrid_worker_recent_300_proof_missing");
  }
  return {
    checkedAt: new Date(checkedAtMs).toISOString(),
    ageMinutes: Math.floor(ageMs / 60_000),
    checkedCount: 300,
    source: String(row.source || ""),
  };
}

if (isMobileTopFallbackMode(shoppingRank)) {
  try {
    const { fallback, ranks, organicOnly, highestExactRank } = await verifiedMobileFallbackEvidence();
    const hybrid = isHybridLocalWorkerMode(shoppingRank);
    const workerEvidence = hybrid ? await verifiedHybridWorkerEvidence() : null;
    const evidence = {
      ok: hybrid,
      code: hybrid ? "SHOPPING_RANK_HYBRID_LIVE_READY" : "SHOPPING_RANK_FULL_300_REQUIRED",
      mode: hybrid ? "hybrid_local_worker" : "verified_mobile_top_fallback",
      source: fallback.source,
      rankEvidence: fallback.rankEvidence,
      checkedCount: fallback.checkedCount,
      firstRank: ranks[0],
      highestExactRank,
      verifiedThroughRank: fallback.verifiedThroughRank,
      organicOnly,
      safeExactMatchReady: true,
      fullCoverageReady: Boolean(workerEvidence),
      deploymentEligible: Boolean(workerEvidence),
      workerEvidence,
      missPolicy: "preserve_last_verified_rank",
      latencyMs: Date.now() - startedAt,
      message: workerEvidence
        ? "The exact top window and a recent atomic 300-rank worker result both passed."
        : "The exact top-window path passed, but production still requires a verified 300-rank source.",
    };
    (workerEvidence ? console.log : console.error)(JSON.stringify(evidence, null, 2));
    process.exit(workerEvidence ? 0 : 1);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: "SHOPPING_RANK_MOBILE_TOP_FALLBACK_NOT_READY",
      message: String(error?.message || "mobile_top_fallback_live_check_failed"),
      keyword,
      latencyMs: Date.now() - startedAt,
    }, null, 2));
  }
  process.exit(1);
}

if (!providerUrl || !providerKey) {
  console.error(JSON.stringify({
    ok: false,
    code: "SHOPPING_RANK_SOURCE_NOT_CONFIGURED",
    message: "N Shopping collector URL/key pair is required.",
  }, null, 2));
  process.exit(1);
}

const rankUrl = new URL(providerUrl);
const readyUrl = new URL("/ready", rankUrl.origin);

try {
  await waitForVerifiedReadiness(readyUrl, providerKey);

  const requestBody = {
    schemaVersion: NAVER_SHOPPING_ORGANIC_WINDOW_SCHEMA,
    keyword,
    limit,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: new Date(Date.now() + 90_000).toISOString(),
    requestId: `live-${Date.now()}`,
  };
  const response = await fetchWithTimeout(rankUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${providerKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  }, 90_000);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`collector_http_${response.status}:${payload?.message || "unknown"}`);
  const window = trustedCollectorWindow(payload, { keyword, maxRank: limit });
  if (window.complete !== true) throw new Error("collector_incomplete_window");
  if (window.checkedCount !== limit) {
    throw new Error(`collector_window_short:${window.checkedCount}/${limit}`);
  }

  console.log(JSON.stringify({
    ok: true,
    source: window.source,
    rankEvidence: window.rankEvidence,
    schemaVersion: window.schemaVersion,
    keyword: window.keyword,
    collectionId: window.collectionId,
    checkedCount: window.checkedCount,
    excludedAdCount: window.excludedAdCount,
    sourceExhausted: window.sourceExhausted,
    latencyMs: Date.now() - startedAt,
  }, null, 2));
} catch (error) {
  const primaryFailure = shoppingCollectorFailureStatus(error);
  if (primaryFailure.status === "unavailable") {
    try {
      const { fallback, ranks, organicOnly } = await verifiedMobileFallbackEvidence();
      const fallbackEvidence = {
        ok: false,
        mode: "verified_mobile_top_fallback",
        source: fallback.source,
        rankEvidence: fallback.rankEvidence,
        schemaVersion: fallback.schemaVersion,
        keyword: fallback.keyword,
        checkedCount: fallback.checkedCount,
        firstRank: ranks[0],
        lastRank: ranks.at(-1),
        organicOnly,
        fullCollectorReady: false,
        deploymentEligible: false,
        missPolicy: "preserve_last_verified_rank",
        latencyMs: Date.now() - startedAt,
      };
      console.error(JSON.stringify({
        ...fallbackEvidence,
        code: "SHOPPING_RANK_FULL_300_REQUIRED",
        message: "Verified top fallback is safe for exact matches but is not a full 300-rank deployment proof.",
      }, null, 2));
      process.exit(1);
    } catch (fallbackError) {
      error.fallbackError = fallbackError;
    }
  }
  console.error(JSON.stringify({
    ok: false,
    message: String(error?.message || "collector_live_check_failed"),
    fallbackMessage: error?.fallbackError ? String(error.fallbackError?.message || "fallback_live_check_failed") : undefined,
    keyword,
    limit,
    latencyMs: Date.now() - startedAt,
  }, null, 2));
  process.exit(1);
}

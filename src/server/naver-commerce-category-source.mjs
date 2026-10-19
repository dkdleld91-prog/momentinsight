import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { normalizeRelatedKeyword, readBoundedJson } from "./category-source-utils.mjs";

const TOKEN_URL = "https://api.commerce.naver.com/external/v1/oauth2/token";
const CATALOG_URL = "https://api.commerce.naver.com/external/v1/product-models";
const TIMEOUT_MS = 4_000;
const MAX_BYTES = 256 * 1024;
const SAMPLE_LIMIT = 20;
const COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 60 * 60_000;
const TOKEN_MARGIN_MS = 60_000;
const MAX_TOKEN_SECONDS = 10_800;
const ERROR_CODES = new Set([
  "source_unavailable", "source_config_invalid", "source_permission", "source_timeout",
  "source_aborted", "source_cooldown", "rate_limited", "deadline_exceeded",
  "response_too_large", "invalid_response", "invalid_sample", "invalid_keyword",
]);
const CONFIG_FIELDS = ["NAVER_COMMERCE_CLIENT_ID", "NAVER_COMMERCE_CLIENT_SECRET", "NAVER_COMMERCE_TOKEN_TYPE", "NAVER_COMMERCE_ACCOUNT_ID"];

function configFor(env) {
  const values = CONFIG_FIELDS.map((name) => typeof env?.[name] === "string" ? env[name].trim() : "");
  if (!values.some(Boolean)) return { reason: "source_unavailable" };
  const [clientId, clientSecret, type, accountId] = values;
  // A bounded bcrypt cost prevents a mistaken server-only secret from creating
  // an unbounded CPU job. Official Commerce examples use cost 10.
  const salt = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{22}(?:[./A-Za-z0-9]{31})?$/u.exec(clientSecret);
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(clientId) || !salt || Number(salt[1]) < 4 || Number(salt[1]) > 14
    || !["SELF", "SELLER"].includes(type)
    || (type === "SELF" && accountId) || (type === "SELLER" && !/^[A-Za-z0-9_-]{1,200}$/u.test(accountId))) {
    return { reason: "source_config_invalid" };
  }
  return {
    clientId, clientSecret, type, accountId,
    key: crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex"), reason: "",
  };
}

export function commerceCategoryConfigReason(env = process.env) { return configFor(env).reason; }
export function hasCommerceCategoryConfig(env = process.env) { return commerceCategoryConfigReason(env) === ""; }
export function commerceCategoryCredentialKey(env = process.env) { return configFor(env).key || ""; }

function safeError(error) {
  return new Error(ERROR_CODES.has(error?.message) ? error.message : "source_unavailable");
}

async function defaultSign({ clientId, clientSecret, timestamp }) {
  return Buffer.from(await bcrypt.hash(`${clientId}_${timestamp}`, clientSecret), "utf8").toString("base64");
}

function identifier(value, { int64 = false } = {}) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
  if (typeof value !== "string" || !/^[1-9]\d{0,23}$/u.test(value)) return "";
  if (int64 && BigInt(value) > 9_223_372_036_854_775_807n) return "";
  return value;
}

function categoryPair(value) {
  if (typeof value !== "string" || value.length > 420 || /[<\u0000-\u001f\u007f]/u.test(value)) return null;
  const parts = value.normalize("NFC").split(">").map((part) => part.replace(/\s+/gu, " ").trim());
  if (parts.length < 3 || parts.length > 4 || parts.some((part) => !part || part.length > 100)) return null;
  return { category2: parts[1], category3: parts[2] };
}

export function commerceCatalogSample(payload, keyword, collectedAt) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !Array.isArray(payload.contents) || payload.contents.length > SAMPLE_LIMIT
    || ![0, 1].includes(payload.page) || payload.first !== true || payload.size !== SAMPLE_LIMIT
    || typeof payload.last !== "boolean" || !Number.isSafeInteger(payload.totalElements) || payload.totalElements < 0
    || !Number.isSafeInteger(payload.totalPages) || payload.totalPages < 0
    || payload.totalPages !== Math.ceil(payload.totalElements / SAMPLE_LIMIT)
    || payload.last !== (payload.totalElements <= SAMPLE_LIMIT)
    || payload.contents.length !== Math.min(SAMPLE_LIMIT, payload.totalElements)) {
    throw new Error("invalid_sample");
  }
  const ids = new Set();
  let complete = payload.contents.length > 0;
  const items = payload.contents.map((item) => {
    const catalogId = identifier(item?.id, { int64: true });
    const categoryId = identifier(item?.categoryId);
    if (!catalogId || !categoryId || ids.has(catalogId)) throw new Error("invalid_sample");
    ids.add(catalogId);
    const pair = categoryPair(item?.wholeCategoryName);
    if (!pair) complete = false;
    return { catalogId, categoryId, category2: pair?.category2 || "", category3: pair?.category3 || "" };
  });
  return {
    schemaVersion: "mi.keyword-category-sample.v1", source: "naver_commerce_catalog_sample", keyword,
    complete, collectedAt, items, sampleLimit: SAMPLE_LIMIT,
    hasMore: !payload.last, last: payload.last, totalElements: payload.totalElements,
    ...(items.length === 0 ? { reason: "no_results" } : !complete ? { reason: "incomplete_sample" } : {}),
  };
}

// This source has exactly two network destinations: OAuth POST and catalog GET.
// No rank collector, tracker job, database, or paginated crawl is involved.
export function createCommerceCategorySource({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, signImpl = defaultSign } = {}) {
  let currentState;

  function stateFor(config) {
    if (!currentState || currentState.key !== config.key) {
      currentState = { key: config.key, token: "", expiresAt: 0, pending: null, cooldownUntil: 0 };
    }
    return currentState;
  }

  async function boundedOperation(operation, { deadline, signal } = {}) {
    const at = now();
    if (signal?.aborted) throw new Error("source_aborted");
    if (!Number.isFinite(deadline) || deadline <= at) throw new Error("deadline_exceeded");
    const controller = new AbortController();
    let timer;
    let aborted;
    const cancellation = new Promise((_, reject) => {
      aborted = () => {
        controller.abort();
        reject(new Error("source_aborted"));
      };
      signal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("source_timeout"));
      }, Math.max(1, Math.min(TIMEOUT_MS, deadline - at)));
    });
    try {
      const result = await Promise.race([operation(controller.signal), cancellation]);
      if (controller.signal.aborted || signal?.aborted) throw new Error("source_aborted");
      if (now() >= deadline) throw new Error("deadline_exceeded");
      return result;
    } catch (error) {
      throw safeError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    }
  }

  async function fetchJson(url, options, state) {
    const response = await fetchImpl(url, { ...options, redirect: "error" });
    if (!response?.ok) {
      await response?.body?.cancel().catch(() => {});
      const status = response?.status;
      if ([401, 403].includes(status)) {
        state.token = "";
        state.expiresAt = 0;
        state.cooldownUntil = Math.max(state.cooldownUntil, now() + COOLDOWN_MS);
        throw new Error("source_permission");
      }
      if ([418, 429].includes(status)) {
        state.cooldownUntil = Math.max(state.cooldownUntil, now() + COOLDOWN_MS);
        throw new Error(status === 429 ? "rate_limited" : "source_permission");
      }
      throw new Error("source_unavailable");
    }
    return readBoundedJson(response, MAX_BYTES);
  }

  async function issueToken(config, state, deadline, signal) {
    try {
      return await boundedOperation(async (requestSignal) => {
        const timestamp = now();
        const signature = await signImpl({ clientId: config.clientId, clientSecret: config.clientSecret, timestamp });
        if (requestSignal.aborted) throw new Error("source_aborted");
        if (now() >= deadline) throw new Error("source_timeout");
        if (typeof signature !== "string" || !signature || signature.length > 1024 || /\s/u.test(signature)) throw new Error("source_config_invalid");
        const form = new URLSearchParams({
          client_id: config.clientId, timestamp: String(timestamp), grant_type: "client_credentials",
          client_secret_sign: signature, type: config.type,
          ...(config.type === "SELLER" ? { account_id: config.accountId } : {}),
        });
        const payload = await fetchJson(TOKEN_URL, {
          method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(), signal: requestSignal,
        }, state);
        if (requestSignal.aborted) throw new Error("source_aborted");
        if (now() >= deadline) throw new Error("source_timeout");
        if (!payload || typeof payload.access_token !== "string" || !payload.access_token || payload.access_token.length > 8192
          || /[\s\u0000-\u001f\u007f]/u.test(payload.access_token)
          || !Number.isSafeInteger(payload.expires_in) || payload.expires_in <= TOKEN_MARGIN_MS / 1000
          || payload.expires_in > MAX_TOKEN_SECONDS || String(payload.token_type).toLowerCase() !== "bearer") {
          throw new Error("invalid_response");
        }
        // Anchor expiry before issuing the request, not after a slow response.
        state.token = payload.access_token;
        state.expiresAt = timestamp + payload.expires_in * 1000 - TOKEN_MARGIN_MS;
        return state.token;
      }, { deadline, signal });
    } catch (error) {
      // Invalid Commerce OAuth formats can restrict the entire application's
      // quota. An unknown/failed issue is not retried for this credential hour.
      state.cooldownUntil = Math.max(state.cooldownUntil, now() + AUTH_COOLDOWN_MS);
      throw safeError(error);
    }
  }

  async function tokenFor(config, state, deadline, signal) {
    if (state.token && state.expiresAt > now()) return state.token;
    if (!state.pending) {
      const controller = new AbortController();
      const pending = { controller, waiters: 0, settled: false, promise: null };
      state.pending = pending;
      // Sharing must not make a second caller inherit the first caller's short
      // deadline. Each waiter is bounded below; zero waiters abort the issue.
      pending.promise = issueToken(config, state, now() + TIMEOUT_MS, controller.signal).finally(() => {
        pending.settled = true;
        if (state.pending === pending) state.pending = null;
      });
    }
    const pending = state.pending;
    pending.waiters += 1;
    try {
      return await boundedOperation(() => pending.promise, { deadline, signal });
    } finally {
      pending.waiters -= 1;
      if (!pending.waiters && !pending.settled) pending.controller.abort();
    }
  }

  return async function fetchSample(value, { deadline = now() + 16_000, signal } = {}) {
    const keyword = normalizeRelatedKeyword(value);
    if (typeof value !== "string" || value.length > 60 || /[\u0000-\u001f\u007f]/u.test(value) || !keyword) throw new Error("invalid_keyword");
    if (signal?.aborted) throw new Error("source_aborted");
    if (!Number.isFinite(deadline) || deadline <= now()) throw new Error("deadline_exceeded");
    const config = configFor(env);
    if (config.reason) throw new Error(config.reason);
    const state = stateFor(config);
    if (now() < state.cooldownUntil) throw new Error("source_cooldown");
    const token = await tokenFor(config, state, deadline, signal);
    const url = new URL(CATALOG_URL);
    url.searchParams.set("name", keyword);
    url.searchParams.set("page", "1");
    url.searchParams.set("size", String(SAMPLE_LIMIT));
    const result = await boundedOperation(async (requestSignal) => {
      const payload = await fetchJson(url.href, {
        method: "GET", headers: { accept: "application/json", authorization: `Bearer ${token}` }, signal: requestSignal,
      }, state);
      return commerceCatalogSample(payload, keyword, new Date(now()).toISOString());
    }, { deadline, signal });
    return result;
  };
}

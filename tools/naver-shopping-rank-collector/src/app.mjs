import crypto from "node:crypto";
import http from "node:http";

import {
  SCHEMA_VERSION,
  ContractError,
  validateProviderWindow,
  validateRankRequest,
} from "./contract.mjs";
import { createUnconfiguredProvider } from "./provider.mjs";

const SERVICE = "moment-naver-shopping-rank-collector";
const RELEASE = "2026-08-01-organic-window-v1";
export const MAX_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(status, code, detail = "") {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function tokenDigest(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest();
}

function constantTimeSecretEqual(candidate, expected) {
  const left = tokenDigest(candidate);
  const right = tokenDigest(expected);
  const equal = crypto.timingSafeEqual(left, right);
  return Boolean(candidate) && Boolean(expected) && equal;
}

function bearerToken(request) {
  const match = String(request.headers.authorization || "").match(/^Bearer ([^\s]+)$/u);
  return match ? match[1] : "";
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim();
    if (contentType !== "application/json") {
      request.resume();
      reject(new HttpError(415, "unsupported_media_type"));
      return;
    }

    const declaredLength = request.headers["content-length"];
    if (declaredLength != null) {
      const parsed = Number(declaredLength);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_BODY_BYTES) {
        request.resume();
        reject(new HttpError(413, "request_too_large"));
        return;
      }
    }

    let size = 0;
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        body = "";
        return;
      }
      if (!tooLarge) body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "request_too_large"));
        return;
      }
      if (!body) {
        reject(new HttpError(400, "invalid_json"));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "invalid_json"));
      }
    });
    request.on("error", () => reject(new HttpError(400, "request_read_failed")));
  });
}

async function providerStatus(provider) {
  try {
    const status = await provider.status();
    return {
      name: String(status?.name || "unknown"),
      configured: status?.configured === true,
      verified: status?.verified === true,
      reason: String(status?.reason || ""),
    };
  } catch {
    return {
      name: "unknown",
      configured: false,
      verified: false,
      reason: "provider_status_failed",
    };
  }
}

async function ensureProviderReady(provider) {
  let status = await providerStatus(provider);
  if (
    status.configured
    && !status.verified
    && typeof provider?.verifyReadiness === "function"
  ) {
    await provider.verifyReadiness().catch(() => false);
    status = await providerStatus(provider);
  }
  return status;
}

function errorBody(error) {
  return {
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    message: error.code || error.message || "server_error",
    ...(error.detail ? { detail: error.detail } : {}),
  };
}

function createRequestHandler({
  secret = "",
  provider = createUnconfiguredProvider(),
  now = () => new Date(),
} = {}) {
  const configuredSecret = String(secret || "");

  return async function handleRequest(request, response) {
    try {
      const url = new URL(request.url || "/", "http://localhost");

      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/ready")) {
        const status = await providerStatus(provider);
        const ready = Boolean(configuredSecret) && status.configured && status.verified;
        const body = {
          ok: url.pathname === "/health" ? true : ready,
          service: SERVICE,
          release: RELEASE,
          schemaVersion: SCHEMA_VERSION,
          secretConfigured: Boolean(configuredSecret),
          provider: status,
          ready,
          checkedAt: now().toISOString(),
        };
        return sendJson(response, url.pathname === "/health" || ready ? 200 : 503, body);
      }

      if (request.method !== "POST" || url.pathname !== "/rank/naver-shopping") {
        request.resume();
        return sendJson(response, 404, {
          ok: false,
          schemaVersion: SCHEMA_VERSION,
          message: "not_found",
        });
      }

      if (!configuredSecret) {
        request.resume();
        return sendJson(response, 503, {
          ok: false,
          schemaVersion: SCHEMA_VERSION,
          message: "collector_secret_missing",
        });
      }
      if (!constantTimeSecretEqual(bearerToken(request), configuredSecret)) {
        request.resume();
        return sendJson(
          response,
          401,
          { ok: false, schemaVersion: SCHEMA_VERSION, message: "unauthorized" },
          { "www-authenticate": "Bearer" }
        );
      }

      const body = await readJson(request);
      let rankRequest;
      try {
        rankRequest = validateRankRequest(body, { nowMs: now().getTime() });
      } catch (error) {
        if (error instanceof ContractError) throw new HttpError(400, error.code, error.detail);
        throw error;
      }

      const status = await ensureProviderReady(provider);
      if (!status.configured || !status.verified) {
        throw new HttpError(503, "provider_not_ready", status.reason);
      }

      let rawResult;
      try {
        rawResult = await provider.collect(rankRequest);
      } catch (error) {
        const detail = error?.code || error?.message || "";
        if (detail === "provider_queue_full" || detail === "provider_queue_deadline_exceeded") {
          throw new HttpError(429, "provider_busy", detail);
        }
        throw new HttpError(502, "provider_collection_failed", detail);
      }

      let result;
      try {
        result = validateProviderWindow(rawResult, rankRequest);
      } catch (error) {
        if (error instanceof ContractError) {
          if (error.detail === "completion") {
            throw new HttpError(502, "provider_response_incomplete", "partial_window_rejected");
          }
          throw new HttpError(502, "provider_response_untrusted", error.code);
        }
        throw error;
      }
      if (!result.complete) {
        throw new HttpError(502, "provider_response_incomplete", "partial_window_rejected");
      }
      return sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof HttpError) return sendJson(response, error.status, errorBody(error));
      return sendJson(response, 500, {
        ok: false,
        schemaVersion: SCHEMA_VERSION,
        message: "server_error",
      });
    }
  };
}

export function createCollectorServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}

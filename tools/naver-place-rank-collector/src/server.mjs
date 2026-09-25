import http from "node:http";
import { containerMemory, lookupNaverPlaceRank } from "./naver-place-rank.mjs";

const PORT = Number(process.env.PORT || 8797);
const HOST = String(process.env.HOST || "127.0.0.1").trim();
const SECRET = String(process.env.PLACE_RANK_COLLECTOR_SECRET || "").trim();
const RELEASE = "2026-09-25-free-tier-low-memory-v25";
const STARTED_AT = new Date().toISOString();
let activeLookup = false;
// 2026-09-25: 운영에서 조회가 이유 없이 끊겨(프로세스 종료 추정) 원인을 볼 수 없었다. 기술 정보만 남긴다
// (키워드·장소 이름은 /health 가 공개 주소라 싣지 않는다). 재시작하면 startedAt 이 바뀐다.
let lastLookup = null;

function sendJson(response, body, status = 200, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request_too_large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.on("error", reject);
  });
}

function bearerToken(request) {
  const value = String(request.headers.authorization || "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function safeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right || left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", "http://localhost");

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, {
      ok: true,
      service: "moment-naver-place-rank-collector",
      release: RELEASE,
      configured: Boolean(SECRET),
      deepProviderConfigured: Boolean(
        process.env.APIFY_NAVER_MAPS_TOKEN || process.env.APIFY_TOKEN
      ),
      busy: activeLookup,
      startedAt: STARTED_AT,
      uptimeSec: Math.round(process.uptime()),
      memory: containerMemory(),
      // 실제로 적용된 한도(환경 변수로 덮였는지 확인용).
      limits: {
        maxScrollsPerPage: Math.max(1, Number(process.env.NAVER_PLACE_PROVIDER_MAX_SCROLLS || 90)),
        pageTimeoutMs: Number(process.env.NAVER_PLACE_PROVIDER_TIMEOUT_MS || 90000),
        overallTimeoutMs: Number(process.env.NAVER_PLACE_PROVIDER_OVERALL_TIMEOUT_MS || 210000),
      },
      lastLookup,
      checkedAt: new Date().toISOString(),
    });
  }

  if (request.method !== "POST" || url.pathname !== "/rank/naver-place") {
    return sendJson(response, { ok: false, message: "not_found" }, 404);
  }

  if (!SECRET) return sendJson(response, { ok: false, message: "collector_secret_missing" }, 500);
  if (!safeEqual(bearerToken(request), SECRET)) {
    return sendJson(response, { ok: false, message: "unauthorized" }, 401);
  }

  if (activeLookup) {
    return sendJson(response, { ok: false, message: "collector_busy" }, 429, { "retry-after": "10" });
  }

  activeLookup = true;
  const lookupStartedAt = Date.now();
  lastLookup = { startedAt: new Date(lookupStartedAt).toISOString(), finished: false };
  try {
    const payload = await readJson(request);
    const result = await lookupNaverPlaceRank(payload);
    lastLookup = {
      startedAt: lastLookup.startedAt,
      finished: true,
      ms: Date.now() - lookupStartedAt,
      ok: result.ok === true,
      matched: result.matched === true,
      checkedCount: Number(result.checkedCount || 0),
      diagnostics: result.collectionDiagnostics || null,
      memory: containerMemory(),
    };
    return sendJson(response, result, result.ok ? 200 : 422);
  } catch (error) {
    lastLookup = {
      startedAt: lastLookup.startedAt,
      finished: true,
      ms: Date.now() - lookupStartedAt,
      ok: false,
      error: String(error?.message || "place_rank_lookup_failed").slice(0, 80),
      memory: containerMemory(),
    };
    return sendJson(response, {
      ok: false,
      matched: false,
      message: error?.message || "place_rank_lookup_failed",
    }, 500);
  } finally {
    activeLookup = false;
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendJson(response, { ok: false, message: error?.message || "server_error" }, 500);
  });
});

server.listen(PORT, HOST, () => {
  console.log("Moment Naver Place rank collector listening on " + HOST + ":" + PORT);
});

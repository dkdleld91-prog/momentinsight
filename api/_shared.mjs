import app from "../src/server/index.mjs";
import { logAdapterFailure, nodeRequestId, safeErrorPayload } from "./error-safety.mjs";


async function writeWebResponse(res, response) {
  const rawBuffer = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  const rawText = rawBuffer.toString("utf8");
  const safe = safeErrorPayload(response, rawText);

  res.statusCode = safe ? safe.status : response.status;
  response.headers.forEach((value, key) => {
    if (safe && key.toLowerCase() === "content-length") return;
    res.setHeader(key, value);
  });

  if (safe) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(safe.body));
    return;
  }

  res.end(rawBuffer);
}

function requestUrl(req, pathname) {
  const protocol = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers.host || "insight.momentlabs.co.kr";
  const rawUrl = req.url || pathname;
  const query = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
  return `${protocol}://${host}${pathname}${query}`;
}

export function createHandler(pathname) {
  return async function handler(req, res) {
    const requestId = nodeRequestId(req);
    try {
      const method = req.method || "GET";
      const hasBody = !["GET", "HEAD"].includes(method);
      const request = new Request(requestUrl(req, pathname), {
        method,
        headers: req.headers,
        body: hasBody ? req : undefined,
        duplex: hasBody ? "half" : undefined,
      });
      const response = await app.fetch(request);
      await writeWebResponse(res, response);
    } catch (error) {
      logAdapterFailure(req, requestId, error);
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("x-request-id", requestId);
      res.end(JSON.stringify({
        ok: false,
        message: "서버 처리 중 오류가 발생했습니다.",
        code: "SERVER_ERROR",
        requestId,
      }));
    }
  };
}

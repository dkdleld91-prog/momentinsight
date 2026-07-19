import app from "../src/server/index.mjs";
import { logAdapterFailure, nodeRequestId } from "./error-safety.mjs";
import { writeWebResponse } from "./response-adapter.mjs";
export { safeErrorPayload } from "./error-safety.mjs";


async function nodeRequestToWebRequest(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers.host || "momentinsight.com";
  const url = `${protocol}://${host}${req.url || "/"}`;
  const method = req.method || "GET";
  const hasBody = !["GET", "HEAD"].includes(method);

  return new Request(url, {
    method,
    headers: req.headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

export default async function handler(req, res) {
  const requestId = nodeRequestId(req);
  try {
    const request = await nodeRequestToWebRequest(req);
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
}

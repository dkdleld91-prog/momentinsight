import app from "../src/server/index.mjs";

function safeErrorPayload(response, text) {
  if (response.status < 500) return null;

  const sensitive = /\b(SUPABASE|SECRET|TOKEN|KEY|JWKS|MISSING_[A-Z0-9_]+)\b/i.test(text);
  try {
    const payload = JSON.parse(text || "{}");
    const code = String(payload?.code || "");
    const statuses = Object.values(payload?.sourceStatus || {});
    const isExpectedConfigPending = /_NOT_CONFIGURED$/.test(code) ||
      statuses.some((item) => item?.status === "not_configured");
    if (isExpectedConfigPending) return null;
    if (payload && payload.ok === false && payload.message && !sensitive) return null;
  } catch {}

  return {
    status: sensitive ? 503 : 500,
    body: {
      ok: false,
      message: sensitive
        ? "서버 연결이 준비되지 않았습니다. 관리자 설정을 확인해주세요."
        : "서버 처리 중 오류가 발생했습니다.",
      code: sensitive ? "SERVER_CONFIGURATION_PENDING" : "SERVER_ERROR",
    },
  };
}


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

export default async function handler(req, res) {
  try {
    const request = await nodeRequestToWebRequest(req);
    const response = await app.fetch(request);
    await writeWebResponse(res, response);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: false,
      message: "서버 처리 중 오류가 발생했습니다.",
    }));
  }
}

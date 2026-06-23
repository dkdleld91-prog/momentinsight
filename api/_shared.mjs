import app from "../src/server/index.mjs";

async function writeWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
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
    } catch {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        ok: false,
        message: "서버 처리 중 오류가 발생했습니다.",
      }));
    }
  };
}

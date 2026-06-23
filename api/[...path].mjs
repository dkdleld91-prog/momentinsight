import app from "../src/server/index.mjs";

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

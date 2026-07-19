import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { logAdapterFailure, nodeRequestId } from "../../api/error-safety.mjs";

const PORT = Number(process.env.PORT || 8790);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const source = fs.readFileSync(filePath, "utf8");
  source.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index === -1) return;
    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1);
    if (!(key in process.env)) process.env[key] = value;
  });
}

loadEnvFile(path.join(process.cwd(), "05_네이버_API_연동", ".env.local"));
loadEnvFile(path.join(process.cwd(), "06_Supabase_연동", ".env.local"));

const app = (await import("./index.mjs")).default;

async function nodeRequestToWebRequest(req) {
  const protocol = "http";
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = `${protocol}://${host}${req.url || "/"}`;
  const method = req.method || "GET";
  const hasBody = !["GET", "HEAD"].includes(method);

  return new Request(url, {
    method,
    headers: req.headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? "half" : undefined
  });
}

async function writeWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  const body = response.body;
  if (!body) {
    res.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

const server = http.createServer(async (req, res) => {
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
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Moment Insight API dev server: http://127.0.0.1:${PORT}`);
});

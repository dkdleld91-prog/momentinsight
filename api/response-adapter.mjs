import { safeErrorPayload } from "./error-safety.mjs";

export async function writeWebResponse(res, response) {
  const rawBuffer = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  const rawText = rawBuffer.toString("utf8");
  const safe = safeErrorPayload(response, rawText);
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [];

  res.statusCode = safe ? safe.status : response.status;
  response.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized === "set-cookie") return;
    if (safe && normalized === "content-length") return;
    res.setHeader(key, value);
  });
  if (setCookies.length) res.setHeader("set-cookie", setCookies);

  if (safe) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(safe.body));
    return;
  }

  res.end(rawBuffer);
}

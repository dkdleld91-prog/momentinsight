const MAX_BYTES = 256 * 1024;

export function normalizeRelatedKeyword(value) {
  return typeof value === "string" ? value.normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, 60) : "";
}

export function relatedKeywordKey(value) {
  return normalizeRelatedKeyword(value).replace(/\s+/gu, "").toLowerCase();
}

export async function readBoundedJson(response, maxBytes = MAX_BYTES) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("response_too_large");
  const type = String(response.headers.get("content-type") || "");
  if (!/application\/(?:[a-z0-9.+-]+\+)?json\b/iu.test(type)) throw new Error("invalid_response");
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("response_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, bytes).toString("utf8");
  try { return JSON.parse(body); } catch { throw new Error("invalid_response"); }
}

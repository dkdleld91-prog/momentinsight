import { isIP } from "node:net";
import { handlePublicRelatedKeywords } from "./public-related-keywords.mjs";

export function trustedPublicClientIp(req, env = process.env) {
  // Vercel supplies this header. Never trust caller-controlled x-forwarded-for/x-real-ip.
  const raw = env.VERCEL === "1" ? req.headers?.["x-vercel-forwarded-for"] : req.socket?.remoteAddress;
  if (typeof raw !== "string") return "";
  const ip = raw.split(",")[0].trim();
  return isIP(ip) ? ip : "";
}

export async function publicRelatedNodeResponse(req, { handler = handlePublicRelatedKeywords, env = process.env } = {}) {
  if ((req.method || "GET") !== "GET") return Response.json({ ok: false, reason: "method_not_allowed", message: "GET 요청만 가능합니다." }, { status: 405, headers: { "cache-control": "no-store", allow: "GET" } });
  if (String(req.url || "").length > 4096) return Response.json({ ok: false, reason: "keyword_required", message: "60자 이내의 키워드를 입력해주세요." }, { status: 400, headers: { "cache-control": "no-store" } });
  // No cookie, authorization, x-mi-* or arbitrary host is forwarded into the public service.
  const input = new URL(String(req.url || "/api/public/related-keywords"), "https://insight.momentlabs.co.kr");
  const url = new URL("https://insight.momentlabs.co.kr/api/public/related-keywords");
  for (const keyword of input.searchParams.getAll("keyword")) url.searchParams.append("keyword", keyword);
  const method = req.method || "GET";
  const request = new Request(url, { method });
  return handler(request, { clientIp: trustedPublicClientIp(req, env) });
}

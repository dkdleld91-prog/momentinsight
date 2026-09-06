import { createHandler } from "../_shared.mjs";

// /api/my/* 를 함수 하나로 받는다(Vercel Hobby 함수 상한 12 대응). 리소스 이름만 복원해
// 기존 라우터·세션 게이트(src/server/index.mjs)로 넘긴다. api/client/[resource].mjs 와 같은 방식.
const RESOURCE_PATTERN = /^[a-z0-9-]{1,64}$/;

function resourceOf(req) {
  const fromQuery = typeof req.query?.resource === "string" ? req.query.resource : "";
  const pathname = String(req.url || "").split("?")[0];
  const fromUrl = pathname.split("/").filter(Boolean)[2] || "";
  return String(fromQuery || fromUrl).trim().toLowerCase();
}

function stripResourceParam(req) {
  const raw = String(req.url || "");
  const index = raw.indexOf("?");
  if (index === -1) return;
  const params = new URLSearchParams(raw.slice(index + 1));
  params.delete("resource");
  const query = params.toString();
  req.url = raw.slice(0, index) + (query ? `?${query}` : "");
}

export default async function handler(req, res) {
  const resource = resourceOf(req);
  if (!RESOURCE_PATTERN.test(resource)) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, message: "Not found" }));
    return;
  }
  stripResourceParam(req);
  return createHandler(`/api/my/${resource}`)(req, res);
}

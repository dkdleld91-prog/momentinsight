import { createHandler } from "../_shared.mjs";

// /api/client/* 전체를 함수 하나로 받는다.
// - Vercel 프로덕션에서 api/[...path] 캐치올은 /api/<한 단계> 경로만 받고 중첩 경로는
//   플랫폼 NOT_FOUND 를 돌려준다(2026-09-04 실측). 그래서 전용 함수가 필요하다.
// - 함수 수 상한(12) 때문에 리소스마다 파일을 두지 않고 동적 세그먼트 하나로 묶는다.
// - 세션 판정·대상 광고주 결정·리소스 분기는 그대로 src/server/index.mjs →
//   handlers/client-api.mjs 가 한다. 여기서는 경로만 복원해 넘긴다.
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
  return createHandler(`/api/client/${resource}`)(req, res);
}

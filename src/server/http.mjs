export function json(data, status = 200) {
  return Response.json(data, { status });
}

export function routeParts(request, basePrefix) {
  const url = new URL(request.url);
  const parts = url.pathname
    .replace(basePrefix, "")
    .split("/")
    .filter(Boolean);

  return {
    url,
    resource: parts[0] || "",
    id: parts[1] || null
  };
}

export async function readBody(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return {};

  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export function parseLimit(url, fallback = 50, max = 200) {
  const raw = Number(url.searchParams.get("limit") || fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

export function databaseError(error, hint) {
  return json({
    ok: false,
    message: error.message,
    code: error.code,
    hint
  }, 500);
}

export function methodNotAllowed(methods) {
  return json({
    ok: false,
    message: "Method not allowed",
    allowed: methods
  }, 405);
}

export function notFound(routes = []) {
  return json({
    ok: false,
    message: "Not found",
    routes
  }, 404);
}

async function healthHandler() {
  return Response.json({
    ok: true,
    status: "live",
    service: "moment-insight-api",
    region: String(process.env.VERCEL_REGION || "local"),
    release: String(process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "local").slice(0, 12),
    time: new Date().toISOString()
  });
}

export default {
  fetch: healthHandler
};

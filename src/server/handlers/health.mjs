import { withSupabase } from "@supabase/server";

const hasSecretKey = Boolean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SECRET_KEYS);

async function healthHandler(_req, ctx) {
  return Response.json({
    ok: true,
    service: "moment-insight-api",
    authMode: ctx?.authMode || "none",
    supabaseServerContext: Boolean(ctx),
    hasSecretKey,
    time: new Date().toISOString()
  });
}

export default {
  fetch: hasSecretKey ? withSupabase({ auth: "none" }, healthHandler) : healthHandler
};

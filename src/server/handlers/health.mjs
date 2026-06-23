import { withSupabase } from "@supabase/server";

const hasSecretKey = Boolean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SECRET_KEYS);
const supabaseEnv = {
  url: Boolean(process.env.SUPABASE_URL),
  publishableKey: Boolean(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEYS),
  secretKey: hasSecretKey,
  jwks: Boolean(process.env.SUPABASE_JWKS_URL || process.env.SUPABASE_JWKS),
};
const supabaseReady = Object.values(supabaseEnv).every(Boolean);

async function healthHandler(_req, ctx) {
  return Response.json({
    ok: true,
    service: "moment-insight-api",
    authMode: ctx?.authMode || "none",
    supabaseServerContext: Boolean(ctx),
    readiness: {
      supabaseReady,
      supabaseEnv,
    },
    time: new Date().toISOString()
  });
}

export default {
  fetch: hasSecretKey ? withSupabase({ auth: "none" }, healthHandler) : healthHandler
};

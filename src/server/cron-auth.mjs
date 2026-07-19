import { safeEqual } from "./security.mjs";

function configuredCronSecrets(env = process.env) {
  return [...new Set([
    env.CRON_SECRET,
    env.MI_RANK_CRON_SECRET,
  ].map((value) => String(value || "").trim()).filter(Boolean))];
}

export function cronAuthorized(request, env = process.env) {
  const secrets = configuredCronSecrets(env);
  if (!secrets.length) return false;

  const authorization = request.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  return secrets.some((secret) => safeEqual(token, secret));
}

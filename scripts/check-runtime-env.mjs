import fs from "node:fs";
import path from "node:path";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};

  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return acc;

      const index = trimmed.indexOf("=");
      if (index === -1) return acc;

      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      acc[key] = value;
      return acc;
    }, {});
}

function mergeEnv() {
  const root = process.cwd();
  return {
    ...loadEnv(path.join(root, ".env.local")),
    ...loadEnv(path.join(root, "05_네이버_API_연동", ".env.local")),
    ...loadEnv(path.join(root, "06_Supabase_연동", ".env.local")),
    ...process.env,
  };
}

function hasAny(env, names) {
  return names.some((name) => Boolean(env[name]));
}

function status(env, label, names, required = true, valid = null) {
  const present = hasAny(env, names);
  return {
    label,
    required,
    names,
    present,
    valid: valid ? Boolean(valid(env)) : present,
  };
}

const env = mergeEnv();
const strictNaver = process.argv.includes("--naver") ||
  process.argv.includes("--production") ||
  env.MI_REQUIRE_NAVER_ENV === "true" ||
  env.VERCEL_ENV === "production";
const productionMode = process.argv.includes("--production") ||
  env.VERCEL_ENV === "production";
const checks = [
  status(env, "Supabase URL", ["SUPABASE_URL"]),
  status(env, "Supabase publishable key", ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEYS"]),
  status(env, "Supabase secret key", ["SUPABASE_SECRET_KEY", "SUPABASE_SECRET_KEYS"]),
  status(env, "Supabase JWKS", ["SUPABASE_JWKS_URL", "SUPABASE_JWKS"]),
  status(env, "Allowed origins", ["MI_ALLOWED_ORIGINS", "ALLOWED_ORIGINS"], false),
  status(env, "Naver SearchAd API key", ["NAVER_SEARCHAD_API_KEY"], strictNaver),
  status(env, "Naver SearchAd secret", ["NAVER_SEARCHAD_SECRET_KEY"], strictNaver),
  status(env, "Naver SearchAd customer", ["NAVER_SEARCHAD_CUSTOMER_ID"], strictNaver),
  status(env, "Naver DataLab client", ["NAVER_DATALAB_CLIENT_ID", "NAVER_OPENAPI_CLIENT_ID"], strictNaver),
  status(env, "Naver DataLab secret", ["NAVER_DATALAB_CLIENT_SECRET", "NAVER_OPENAPI_CLIENT_SECRET"], strictNaver),
  status(env, "Naver OpenAPI client", ["NAVER_OPENAPI_CLIENT_ID", "NAVER_DATALAB_CLIENT_ID"], strictNaver),
  status(env, "Naver OpenAPI secret", ["NAVER_OPENAPI_CLIENT_SECRET", "NAVER_DATALAB_CLIENT_SECRET"], strictNaver),
  status(env, "Keyword API enabled", ["MI_KEYWORD_API_ENABLED"], strictNaver, (merged) => merged.MI_KEYWORD_API_ENABLED === "true"),
  status(env, "Rank tracker admin code", ["MI_RANK_ADMIN_CODE", "MI_DEMO_ADMIN_CODE"], false),
  status(env, "Rank tracker client access code", ["MI_RANK_ACCESS_CODE", "MI_RANK_ACCESS_CODES"], false),
  status(env, "Rank tracker cron secret", ["MI_RANK_CRON_SECRET", "CRON_SECRET"], productionMode),
  status(env, "Meta Ad Library access token", ["META_AD_LIBRARY_ACCESS_TOKEN", "META_ADS_LIBRARY_ACCESS_TOKEN"], false),
  status(env, "Primary agency code", ["MI_PRIMARY_AGENCY_CODE"], false),
  status(env, "Legacy agency codes", ["MI_LEGACY_AGENCY_CODES"], false),
  status(env, "Super admin code", ["MI_SUPER_ADMIN_CODE"], productionMode),
];

const missingRequired = checks.filter((check) => check.required && !check.valid);

console.log(JSON.stringify({
  ok: missingRequired.length === 0,
  strictNaver,
  productionMode,
  checkedAt: new Date().toISOString(),
  checks: checks.map((check) => ({
    label: check.label,
    required: check.required,
    status: check.valid ? "ready" : check.present ? "invalid" : "missing",
    envNames: check.names,
  })),
}, null, 2));

if (missingRequired.length) process.exit(1);

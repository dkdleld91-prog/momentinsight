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

function hasPair(env, idNames, secretNames) {
  return hasAny(env, idNames) && hasAny(env, secretNames);
}

function hasMigratedNaverPair(env, kind) {
  const hub = hasPair(
    env,
    ["NAVER_API_HUB_CLIENT_ID", "NAVER_API_HUB_API_KEY_ID"],
    ["NAVER_API_HUB_CLIENT_SECRET", "NAVER_API_HUB_API_KEY"],
  );
  const legacy = kind === "datalab"
    ? hasPair(env, ["NAVER_DATALAB_CLIENT_ID", "NAVER_OPENAPI_CLIENT_ID"], ["NAVER_DATALAB_CLIENT_SECRET", "NAVER_OPENAPI_CLIENT_SECRET"])
    : hasPair(env, ["NAVER_OPENAPI_CLIENT_ID", "NAVER_DATALAB_CLIENT_ID"], ["NAVER_OPENAPI_CLIENT_SECRET", "NAVER_DATALAB_CLIENT_SECRET"]);
  return hub || legacy;
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
  status(env, "Naver migrated DataLab provider", ["NAVER_API_HUB_CLIENT_ID", "NAVER_API_HUB_API_KEY_ID", "NAVER_DATALAB_CLIENT_ID", "NAVER_OPENAPI_CLIENT_ID"], strictNaver, (merged) => hasMigratedNaverPair(merged, "datalab")),
  status(env, "Naver API Hub client", ["NAVER_API_HUB_CLIENT_ID", "NAVER_API_HUB_API_KEY_ID"], false),
  status(env, "Naver API Hub secret", ["NAVER_API_HUB_CLIENT_SECRET", "NAVER_API_HUB_API_KEY"], false),
  status(env, "Naver OpenAPI client", ["NAVER_OPENAPI_CLIENT_ID", "NAVER_DATALAB_CLIENT_ID"], strictNaver),
  status(env, "Naver OpenAPI secret", ["NAVER_OPENAPI_CLIENT_SECRET", "NAVER_DATALAB_CLIENT_SECRET"], strictNaver),
  status(env, "Naver Place rank provider URL", ["NAVER_PLACE_RANK_API_URL"], false),
  status(env, "Naver Place rank provider key", ["NAVER_PLACE_RANK_API_KEY"], false),
  status(env, "Keyword API enabled", ["MI_KEYWORD_API_ENABLED"], strictNaver, (merged) => merged.MI_KEYWORD_API_ENABLED === "true"),
  status(env, "Rank tracker admin code", ["MI_RANK_ADMIN_CODE", "MI_DEMO_ADMIN_CODE"], productionMode),
  status(env, "Rank tracker client access code", ["MI_RANK_ACCESS_CODE", "MI_RANK_ACCESS_CODES"], false),
  status(env, "Rank tracker GitHub cron secret", ["MI_RANK_CRON_SECRET"], productionMode),
  status(env, "Vercel Cron authorization secret", ["CRON_SECRET"], productionMode),
  status(env, "Meta Ad Library access token", ["META_AD_LIBRARY_ACCESS_TOKEN", "META_ADS_LIBRARY_ACCESS_TOKEN"], false),
  status(env, "Primary agency code", ["MI_PRIMARY_AGENCY_CODE"], productionMode, (merged) => (
    !productionMode || merged.MI_PRIMARY_AGENCY_CODE === "mml93-a01"
  )),
  status(env, "Legacy agency codes", ["MI_LEGACY_AGENCY_CODES"], false),
  status(env, "Super admin code", ["MI_SUPER_ADMIN_CODE"], productionMode, (merged) => (
    !productionMode || String(merged.MI_SUPER_ADMIN_CODE || "").length >= 24
  )),
  status(env, "Encrypted session secret", ["MI_SESSION_SECRET"], productionMode, (merged) => (
    !productionMode || Buffer.byteLength(String(merged.MI_SESSION_SECRET || ""), "utf8") >= 32
  )),
  status(env, "Previous encrypted session secret", ["MI_SESSION_SECRET_PREVIOUS"], false, (merged) => (
    !merged.MI_SESSION_SECRET_PREVIOUS || Buffer.byteLength(String(merged.MI_SESSION_SECRET_PREVIOUS), "utf8") >= 32
  )),
  status(env, "Encrypted session TTL", ["MI_SESSION_TTL_SECONDS"], false, (merged) => {
    if (!merged.MI_SESSION_TTL_SECONDS) return true;
    const value = Number(merged.MI_SESSION_TTL_SECONDS);
    return Number.isFinite(value) && value >= 300 && value <= 86400;
  }),
  status(env, "Owner login credential", ["MI_OWNER_LOGIN_CODE_SHA256", "MI_OWNER_LOGIN_CODE"], productionMode, (merged) => {
    if (!productionMode) return true;
    const digest = String(merged.MI_OWNER_LOGIN_CODE_SHA256 || "").trim();
    const secret = String(merged.MI_OWNER_LOGIN_CODE || "");
    return /^[a-f0-9]{64}$/i.test(digest) || secret.length >= 16;
  }),
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

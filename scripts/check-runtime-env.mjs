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
    ...loadEnv(path.join(root, "06_Supabase_연동", ".env.local")),
    ...process.env,
  };
}

function hasAny(env, names) {
  return names.some((name) => Boolean(env[name]));
}

function status(env, label, names, required = true) {
  return {
    label,
    required,
    names,
    present: hasAny(env, names),
  };
}

const env = mergeEnv();
const checks = [
  status(env, "Supabase URL", ["SUPABASE_URL"]),
  status(env, "Supabase publishable key", ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEYS"]),
  status(env, "Supabase secret key", ["SUPABASE_SECRET_KEY", "SUPABASE_SECRET_KEYS"]),
  status(env, "Supabase JWKS", ["SUPABASE_JWKS_URL", "SUPABASE_JWKS"]),
  status(env, "Allowed origins", ["MI_ALLOWED_ORIGINS", "ALLOWED_ORIGINS"], false),
  status(env, "Naver SearchAd API key", ["NAVER_SEARCHAD_API_KEY"], false),
  status(env, "Naver SearchAd secret", ["NAVER_SEARCHAD_SECRET_KEY"], false),
  status(env, "Naver SearchAd customer", ["NAVER_SEARCHAD_CUSTOMER_ID"], false),
  status(env, "Naver Datalab client", ["NAVER_DATALAB_CLIENT_ID"], false),
  status(env, "Naver Datalab secret", ["NAVER_DATALAB_CLIENT_SECRET"], false),
  status(env, "Naver OpenAPI client", ["NAVER_OPENAPI_CLIENT_ID"], false),
  status(env, "Naver OpenAPI secret", ["NAVER_OPENAPI_CLIENT_SECRET"], false),
];

const missingRequired = checks.filter((check) => check.required && !check.present);

console.log(JSON.stringify({
  ok: missingRequired.length === 0,
  checkedAt: new Date().toISOString(),
  checks: checks.map((check) => ({
    label: check.label,
    required: check.required,
    status: check.present ? "present" : "missing",
    envNames: check.names,
  })),
}, null, 2));

if (missingRequired.length) process.exit(1);

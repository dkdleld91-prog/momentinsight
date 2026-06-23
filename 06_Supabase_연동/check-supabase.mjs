import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), "06_Supabase_연동", ".env.local");

function parseEnv(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

const env = parseEnv(envPath);
const url = env.SUPABASE_URL;
const key = env.SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error("SUPABASE_URL 또는 SUPABASE_PUBLISHABLE_KEY가 없습니다.");
  process.exit(1);
}

const response = await fetch(`${url}/auth/v1/settings`, {
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`
  }
});

console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  projectUrl: url,
  keyType: key.startsWith("sb_publishable_") ? "publishable" : "unknown",
  jwksUrl: env.SUPABASE_JWKS_URL || null,
  hasSecretKey: Boolean(env.SUPABASE_SECRET_KEY)
}, null, 2));

if (!response.ok) process.exit(1);

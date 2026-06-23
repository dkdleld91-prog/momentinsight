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

      acc[trimmed.slice(0, index)] = trimmed.slice(index + 1);
      return acc;
    }, {});
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  let body;

  try {
    body = await response.json();
  } catch {
    body = { message: await response.text() };
  }

  return {
    ok: response.ok,
    status: response.status,
    body
  };
}

const env = {
  ...loadEnv(path.join(process.cwd(), "06_Supabase_연동", ".env.local")),
  ...process.env
};

const supabaseUrl = env.SUPABASE_URL;
const secretKey = env.SUPABASE_SECRET_KEY;

if (!supabaseUrl) {
  console.error(JSON.stringify({ ok: false, message: "SUPABASE_URL is missing" }, null, 2));
  process.exit(1);
}

const baseUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/moment-api`;
const health = await getJson(`${baseUrl}/health`);
const admin = secretKey
  ? await getJson(`${baseUrl}/api/admin/clients`, { apikey: secretKey })
  : { ok: false, status: 0, body: { message: "SUPABASE_SECRET_KEY is missing" } };

console.log(JSON.stringify({
  ok: health.ok && [200, 500].includes(admin.status),
  baseUrl,
  health,
  admin
}, null, 2));

if (!health.ok) process.exit(1);

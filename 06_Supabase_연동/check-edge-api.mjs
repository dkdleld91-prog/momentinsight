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

function summarize(body) {
  if (Array.isArray(body)) return { type: "array", count: body.length };
  if (!body || typeof body !== "object") return { type: typeof body };
  return {
    type: "object",
    ok: body.ok,
    message: body.message,
    service: body.service,
    supabaseServerContext: body.supabaseServerContext,
    readiness: body.readiness,
    count: Array.isArray(body.data) ? body.data.length : undefined,
    keys: Object.keys(body).filter((key) => !["data", "result", "items"].includes(key)).slice(0, 8)
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
const allowSchemaPending = process.env.ALLOW_SCHEMA_PENDING === "true";
const adminPassed = admin.ok || (allowSchemaPending && [404, 500, 503].includes(admin.status));
const passed = health.ok && adminPassed;

console.log(JSON.stringify({
  ok: passed,
  baseUrl,
  health: { ok: health.ok, status: health.status, body: summarize(health.body) },
  admin: { ok: adminPassed, status: admin.status, body: summarize(admin.body) }
}, null, 2));

if (!passed) process.exit(1);

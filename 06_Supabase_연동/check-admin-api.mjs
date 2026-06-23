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

const root = process.cwd();
const env = loadEnv(path.join(root, "06_Supabase_연동", ".env.local"));
const secretKey = env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SECRET_KEY;
const apiUrl = process.env.MOMENT_API_URL || "http://127.0.0.1:8790";

if (!secretKey) {
  console.error(JSON.stringify({
    ok: false,
    message: "SUPABASE_SECRET_KEY is missing"
  }, null, 2));
  process.exit(1);
}

const response = await fetch(`${apiUrl}/api/admin/clients`, {
  headers: {
    apikey: secretKey
  }
});

let body;
try {
  body = await response.json();
} catch {
  body = { message: await response.text() };
}

function summarize(body) {
  if (Array.isArray(body)) return { type: "array", count: body.length };
  if (!body || typeof body !== "object") return { type: typeof body };
  return {
    type: "object",
    ok: body.ok,
    message: body.message,
    count: Array.isArray(body.data) ? body.data.length : undefined,
    keys: Object.keys(body).filter((key) => !["data", "result", "items"].includes(key)).slice(0, 8)
  };
}

const allowSchemaPending = process.env.ALLOW_SCHEMA_PENDING === "true";
const passed = response.ok || (allowSchemaPending && [404, 500, 503].includes(response.status));

console.log(JSON.stringify({
  ok: passed,
  status: response.status,
  apiUrl,
  result: summarize(body)
}, null, 2));

if (!passed) {
  process.exit(1);
}

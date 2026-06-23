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

console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  apiUrl,
  result: body
}, null, 2));

if (response.status === 401) {
  process.exit(1);
}

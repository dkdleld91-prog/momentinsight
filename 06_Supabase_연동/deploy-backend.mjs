import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const projectRef = "unjduaxhykcrlotprsie";
const envFile = path.join(process.cwd(), "06_Supabase_연동", ".env.local");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      const index = trimmed.indexOf("=");
      if (index === -1) return;

      const key = trimmed.slice(0, index);
      const value = trimmed.slice(index + 1);
      if (!(key in process.env)) process.env[key] = value;
    });
}

function run(label, command, args) {
  console.log(`\n[${label}] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

loadEnv(envFile);

if (!process.env.SUPABASE_ACCESS_TOKEN) {
  console.error([
    "SUPABASE_ACCESS_TOKEN is missing.",
    "Supabase Dashboard > Account > Access Tokens에서 토큰을 만든 뒤 로컬 환경변수로 넣어야 배포할 수 있습니다.",
    "예: export SUPABASE_ACCESS_TOKEN=sbp_..."
  ].join("\n"));
  process.exit(1);
}

run("Supabase CLI", "npx", ["supabase", "--version"]);
run("Link project", "npx", ["supabase", "link", "--project-ref", projectRef]);
run("Push database", "npx", ["supabase", "db", "push"]);
run("Deploy function", "npx", ["supabase", "functions", "deploy", "moment-api"]);
run("Check deployed API", "npm", ["run", "check:edge-api"]);

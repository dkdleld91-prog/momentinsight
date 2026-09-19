#!/usr/bin/env node
// CSP 해시 교체: node csp-hash-swap.mjs <worktree>  — 페이지별로 HEAD의 인라인 스크립트 해시 → 현재 해시로 vercel.json 교체
import fs from "node:fs"; import crypto from "node:crypto"; import { execFileSync } from "node:child_process";
const W = process.argv[2]; const pages = ["src/pages/client.html", "src/pages/admin.html", "src/pages/home.html", "src/pages/privacy.html", "src/pages/404.html"];
const hashes = (html) => [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => "sha256-" + crypto.createHash("sha256").update(m[1], "utf8").digest("base64"));
let v = fs.readFileSync(`${W}/vercel.json`, "utf8"); let swapped = 0;
for (const p of pages) {
  if (!fs.existsSync(`${W}/${p}`)) continue;
  const now = hashes(fs.readFileSync(`${W}/${p}`, "utf8")); let head = [];
  try { head = hashes(execFileSync("git", ["show", `HEAD:${p}`], { cwd: W, encoding: "utf8", maxBuffer: 1 << 28 })); } catch { head = []; }
  now.forEach((h, i) => { const old = head[i]; if (old && old !== h && v.includes(old)) { v = v.split(old).join(h); swapped += 1; console.log(`${p} #${i + 1}: ${old.slice(0, 18)}… → ${h.slice(0, 18)}…`); } if (!v.includes(h)) console.log(`주의: ${p} #${i + 1} 해시가 vercel.json 에 없음 ${h}`); });
}
fs.writeFileSync(`${W}/vercel.json`, v); console.log(`교체 ${swapped}건`);

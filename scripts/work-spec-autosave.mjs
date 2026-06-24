#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const workSpecPath = path.join(root, "docs", "08-work-spec-autosave.md");

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function kstTimestamp() {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

const content = await fs.readFile(workSpecPath, "utf8");
const head = runGit(["rev-parse", "--short", "HEAD"]) || "unknown";
const status = runGit(["-c", "core.quotepath=false", "status", "--short"]) || "clean";
const statusSummary = status === "clean"
  ? "clean"
  : status.split("\n").slice(0, 8).join(" / ");

const nextBlock = [
  "<!-- autosave:start -->",
  `- 마지막 자동 저장: ${kstTimestamp()}`,
  `- 기준 커밋: ${head}`,
  `- 작업트리: ${statusSummary}`,
  "<!-- autosave:end -->",
].join("\n");

const nextContent = content.replace(
  /<!-- autosave:start -->[\s\S]*?<!-- autosave:end -->/,
  nextBlock,
);

if (nextContent === content) {
  throw new Error("Autosave marker not found in docs/08-work-spec-autosave.md");
}

await fs.writeFile(workSpecPath, nextContent, "utf8");
console.log(`Autosaved work spec at ${kstTimestamp()} (${head})`);

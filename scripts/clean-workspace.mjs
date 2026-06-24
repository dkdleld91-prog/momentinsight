#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || args.has("--dry");
const includeDeps = args.has("--deps");

const fixedTargets = [
  "dist",
  "supabase/.temp",
  "03_운영시트_템플릿/node_modules",
  "03_운영시트_템플릿/outputs",
  "00_이전자료_보관",
  "04_영상_산출물",
];

if (includeDeps) {
  fixedTargets.push("node_modules");
}

const patternTargets = [".DS_Store", ".inspect.ndjson"];
const skippedDirs = new Set([".git", "node_modules"]);

function formatResult(result) {
  if (result.removed) return `removed ${result.target}`;
  if (result.dryRun) return `would remove ${result.target}`;
  return `skip ${result.target}`;
}

function assertInsideRoot(target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, target);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing to clean outside project: ${target}`);
  }

  return resolvedTarget;
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function removeFixedTarget(target) {
  const absoluteTarget = assertInsideRoot(target);

  if (!(await exists(absoluteTarget))) {
    return { target, skipped: true };
  }

  if (dryRun) {
    return { target, dryRun: true };
  }

  await fs.rm(absoluteTarget, { recursive: true, force: true });
  return { target, removed: true };
}

async function walkForPatternTargets(directory, results) {
  let entries;

  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath);

    if (entry.isDirectory()) {
      if (skippedDirs.has(entry.name) || (!includeDeps && relativePath === "03_운영시트_템플릿/node_modules")) {
        continue;
      }

      await walkForPatternTargets(absolutePath, results);
      continue;
    }

    const shouldRemove = patternTargets.some((pattern) => entry.name === pattern || entry.name.endsWith(pattern));

    if (!shouldRemove) continue;

    if (dryRun) {
      results.push({ target: relativePath, dryRun: true });
      continue;
    }

    await fs.rm(absolutePath, { force: true });
    results.push({ target: relativePath, removed: true });
  }
}

const results = [];

for (const target of fixedTargets) {
  results.push(await removeFixedTarget(target));
}

await walkForPatternTargets(root, results);

const activeResults = results.filter((result) => !result.skipped);

if (activeResults.length === 0) {
  console.log("Workspace is already clean.");
} else {
  for (const result of activeResults) {
    console.log(formatResult(result));
  }
}

if (!includeDeps) {
  console.log("Kept root node_modules and local .env files. Use --deps only when dependency reinstall is acceptable.");
}

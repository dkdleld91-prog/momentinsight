import { execFileSync, spawnSync } from "node:child_process";

const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "src/pages/admin.html",
  "src/pages/client.html",
  "src/pages/home.html",
  "src/server/index.mjs",
  "docs/08-work-spec-autosave.md",
];

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function git(args, options) {
  return run("git", args, options);
}

function optionalGit(args) {
  try {
    return git(args);
  } catch {
    return "";
  }
}

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function fail(message) {
  throw new Error(message);
}

function validateName(name) {
  if (!/^checkpoint\/[a-z0-9][a-z0-9._/-]{2,100}$/.test(name)) {
    fail("Checkpoint name must use lowercase letters, numbers, dots, dashes, or slashes under checkpoint/.");
  }
}

function resolveCommit(ref) {
  try {
    return git(["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    fail(`Cannot resolve checkpoint ref: ${ref}`);
  }
}

function verifyRequiredFiles(commit) {
  const missing = REQUIRED_FILES.filter((path) => {
    try {
      git(["cat-file", "-e", `${commit}:${path}`]);
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length) fail(`Checkpoint is missing required files: ${missing.join(", ")}`);
}

function verifyPackageLock(commit) {
  const packageJson = JSON.parse(git(["show", `${commit}:package.json`]));
  const packageLock = JSON.parse(git(["show", `${commit}:package-lock.json`]));
  const lockRoot = packageLock.packages?.[""] || {};
  if (packageJson.name !== packageLock.name || packageJson.version !== packageLock.version) {
    fail("package.json and package-lock.json root metadata do not match.");
  }
  if (lockRoot.name && lockRoot.name !== packageJson.name) fail("package-lock root package name does not match.");
  if (lockRoot.version && lockRoot.version !== packageJson.version) fail("package-lock root package version does not match.");
}

function verifyGitConnectivity() {
  const primaryLine = git(["worktree", "list", "--porcelain"])
    .split("\n")
    .find((line) => line.startsWith("worktree "));
  const primaryWorktree = primaryLine ? primaryLine.slice("worktree ".length).normalize("NFC") : process.cwd();
  run("git", ["fsck", "--connectivity-only"], { inherit: true, cwd: primaryWorktree });
}

function verifyCheckpoint(name, quality) {
  validateName(name);
  const ref = `refs/tags/${name}`;
  if (optionalGit(["cat-file", "-t", ref]) !== "tag") fail(`Checkpoint is missing or is not an annotated tag: ${name}`);
  const commit = resolveCommit(ref);
  verifyRequiredFiles(commit);
  verifyPackageLock(commit);
  verifyGitConnectivity();
  if (quality) {
    const result = spawnSync("npm", ["run", "check:quality"], { cwd: process.cwd(), stdio: "inherit" });
    if (result.status !== 0) fail("Checkpoint quality verification failed.");
  }
  console.log(JSON.stringify({
    ok: true,
    action: "verify",
    name,
    commit,
    qualityChecked: quality,
    requiredFiles: REQUIRED_FILES,
  }, null, 2));
}

function createCheckpoint(name, ref) {
  validateName(name);
  const status = git(["status", "--porcelain"]);
  if (status) fail("Refusing to create a recovery checkpoint from a dirty worktree. Commit or stash the current work first.");
  if (optionalGit(["rev-parse", "-q", "--verify", `refs/tags/${name}`])) fail(`Checkpoint already exists: ${name}`);
  const commit = resolveCommit(ref);
  verifyRequiredFiles(commit);
  verifyPackageLock(commit);
  const createdAt = new Date().toISOString();
  const branch = optionalGit(["branch", "--show-current"]) || "detached";
  const originMain = optionalGit(["rev-parse", "--verify", "origin/main^{commit}"]) || "unavailable";
  const message = [
    "Moment Insight recovery checkpoint",
    `created_at=${createdAt}`,
    `commit=${commit}`,
    `branch=${branch}`,
    `origin_main=${originMain}`,
    `restore=git worktree add --detach /tmp/moment-insight-recovery ${name}`,
  ].join("\n");
  git(["tag", "-a", name, commit, "-m", message]);
  try {
    verifyCheckpoint(name, false);
  } catch (error) {
    optionalGit(["tag", "-d", name]);
    throw error;
  }
  console.log(JSON.stringify({ ok: true, action: "create", name, commit, createdAt }, null, 2));
}

try {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    fail("Run this command inside the Moment Insight Git repository.");
  }

  const action = process.argv[2] || "verify";
  const name = argument("--name");
  if (!name) fail("A checkpoint name is required. Example: --name checkpoint/production-20260716");

  if (action === "create") {
    createCheckpoint(name, argument("--ref", "HEAD"));
  } else if (action === "verify") {
    verifyCheckpoint(name, process.argv.includes("--quality"));
  } else {
    fail(`Unsupported recovery action: ${action}`);
  }
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
}

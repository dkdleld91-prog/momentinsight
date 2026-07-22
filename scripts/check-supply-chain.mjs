import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

const projects = [
  {
    name: "platform",
    manifest: "package.json",
    lockfile: "package-lock.json",
    allowedInstallScripts: new Set(),
  },
  {
    name: "place-rank-collector",
    manifest: "tools/naver-place-rank-collector/package.json",
    lockfile: "tools/naver-place-rank-collector/package-lock.json",
    allowedInstallScripts: new Set(["node_modules/fsevents"]),
  },
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function fail(project, message) {
  failures.push(`${project}: ${message}`);
}

function isExactVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value || ""));
}

function checkManifest(project, manifest) {
  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(manifest[group] || {})) {
      if (!isExactVersion(version)) {
        fail(project.name, `${group}.${name} must use an exact version, received ${version}`);
      }
    }
  }

  for (const [name, command] of Object.entries(manifest.scripts || {})) {
    if (/\bnpx\b/.test(command) && !/\bnpx\s+--no-install\b/.test(command)) {
      fail(project.name, `script ${name} may download an unpinned package through npx`);
    }
  }
}

function checkLockfile(project, manifest, lockfile) {
  if (lockfile.lockfileVersion !== 3) {
    fail(project.name, `lockfileVersion must be 3, received ${lockfile.lockfileVersion}`);
  }

  const rootPackage = lockfile.packages?.[""];
  if (!rootPackage) {
    fail(project.name, "lockfile is missing the root package entry");
    return;
  }

  for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const declared = manifest[group] || {};
    const locked = rootPackage[group] || {};
    for (const [name, version] of Object.entries(declared)) {
      if (locked[name] !== version) {
        fail(project.name, `${group}.${name} does not match the lockfile root entry`);
      }
    }
  }

  for (const [location, item] of Object.entries(lockfile.packages || {})) {
    if (!location) continue;
    if (item.link === true) {
      fail(project.name, `${location} is a linked dependency`);
    }

    if (location.startsWith("node_modules/") && !item.resolved) {
      fail(project.name, `${location} is not locked to an immutable registry artifact`);
    }

    if (item.resolved) {
      let resolved;
      try {
        resolved = new URL(item.resolved);
      } catch {
        fail(project.name, `${location} has an invalid resolved URL`);
        continue;
      }

      if (resolved.protocol !== "https:" || resolved.hostname !== "registry.npmjs.org") {
        fail(project.name, `${location} is not locked to the npm registry over HTTPS`);
      }
      if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(String(item.integrity || ""))) {
        fail(project.name, `${location} is missing a sha512 integrity digest`);
      }
    }

    if (item.hasInstallScript === true) {
      const allowed = project.allowedInstallScripts.has(location) && item.optional === true;
      if (!allowed) {
        fail(project.name, `${location} declares an unexpected lifecycle install script`);
      }
    }
  }
}

function requireText(relativePath, pattern, message) {
  const content = fs.readFileSync(path.join(root, relativePath), "utf8");
  if (!pattern.test(content)) failures.push(`${relativePath}: ${message}`);
}

const npmrcPath = path.join(root, ".npmrc");
if (!fs.existsSync(npmrcPath)) {
  failures.push("root: .npmrc is missing");
} else {
  const npmrc = fs.readFileSync(npmrcPath, "utf8");
  if (!/^ignore-scripts\s*=\s*true\s*$/m.test(npmrc)) {
    failures.push("root: .npmrc must disable dependency lifecycle scripts");
  }
}

for (const project of projects) {
  const manifest = readJson(project.manifest);
  const lockfile = readJson(project.lockfile);
  checkManifest(project, manifest);
  checkLockfile(project, manifest, lockfile);
}

requireText(
  ".github/workflows/quality.yml",
  /npm ci --ignore-scripts/,
  "platform CI install must disable lifecycle scripts",
);
requireText(
  ".github/workflows/quality.yml",
  /npm --prefix tools\/naver-place-rank-collector ci --ignore-scripts/,
  "collector CI install must disable lifecycle scripts",
);
requireText(
  ".github/workflows/quality.yml",
  /persist-credentials:\s*false/,
  "checkout credentials must not persist after source retrieval",
);
requireText(
  ".github/workflows/quality.yml",
  /uses:\s*actions\/checkout@[0-9a-f]{40}\s+#\s+v\d+(?:\.\d+){1,2}/,
  "checkout action must be pinned to a reviewed immutable commit",
);
requireText(
  ".github/workflows/quality.yml",
  /uses:\s*actions\/setup-node@[0-9a-f]{40}\s+#\s+v\d+(?:\.\d+){1,2}/,
  "setup-node action must be pinned to a reviewed immutable commit",
);
requireText(
  ".github/workflows/quality.yml",
  /npm audit signatures/,
  "CI must verify npm registry signatures",
);
requireText(
  ".github/workflows/quality.yml",
  /npm audit --omit=dev --audit-level=high/,
  "CI must block high-severity production dependency advisories",
);
requireText(
  "tools/naver-place-rank-collector/Dockerfile",
  /npm ci --omit=dev --ignore-scripts/,
  "container install must disable lifecycle scripts",
);
requireText(
  "tools/naver-place-rank-collector/Dockerfile",
  /^USER pwuser$/m,
  "collector container must run as the non-root Playwright user",
);

const collectorDockerIgnorePath = path.join(
  root,
  "tools/naver-place-rank-collector/.dockerignore",
);
const collectorDockerIgnorePolicyPath = path.join(
  root,
  "tools/naver-place-rank-collector/dockerignore.policy",
);
const collectorDockerIgnorePolicy = fs.readFileSync(
  collectorDockerIgnorePolicyPath,
  "utf8",
);

if (!/^\*\*$/m.test(collectorDockerIgnorePolicy)) {
  failures.push(
    "tools/naver-place-rank-collector/dockerignore.policy: container build context must default to deny",
  );
}

if (fs.existsSync(collectorDockerIgnorePath)) {
  const collectorDockerIgnore = fs.readFileSync(collectorDockerIgnorePath, "utf8");
  if (collectorDockerIgnore !== collectorDockerIgnorePolicy) {
    failures.push(
      "tools/naver-place-rank-collector/.dockerignore: must exactly match dockerignore.policy",
    );
  }
} else if (process.env.VERCEL !== "1") {
  failures.push(
    "tools/naver-place-rank-collector/.dockerignore: container build context policy is missing",
  );
}

if (failures.length) {
  for (const failure of failures) console.error(`BLOCK ${failure}`);
  console.error(`Supply-chain check blocked: ${failures.length} issue(s)`);
  process.exit(1);
}

console.log(`Supply-chain check passed: ${projects.length} lockfiles, lifecycle scripts disabled`);

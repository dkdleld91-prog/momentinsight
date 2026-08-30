import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const N30_RUNTIME_COMPONENTS = Object.freeze([
  "tools/naver-shopping-chrome-extension/service-worker.js",
  "scripts/naver-shopping-native-host.mjs",
  "scripts/naver-shopping-native-host-core.mjs",
  "scripts/naver-shopping-local-worker.mjs",
  "src/server/local-worker-auth.mjs",
  "src/server/naver-shopping/local-worker-contract.mjs",
  "src/server/handlers/naver-shopping-rank.mjs",
  "src/server/security.mjs",
  "src/server/naver-shopping/source-status.mjs",
  "src/server/naver-shopping/provider-runtime.mjs",
  "src/server/naver-shopping/mobile-top-fallback.mjs",
  "tools/naver-shopping-rank-collector/src/provider.mjs",
  "tools/naver-shopping-rank-collector/src/contract.mjs",
]);

export function calculateN30RuntimeFingerprint({ repositoryRoot, version }) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("runtime_version_invalid");
  const components = N30_RUNTIME_COMPONENTS.map((relativePath) => ({
    relativePath,
    sha256: crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(repositoryRoot, relativePath)))
      .digest("hex"),
  }));
  const fingerprint = crypto.createHash("sha256")
    .update([version, ...components.map(({ sha256 }) => sha256)].join("\n"), "utf8")
    .digest("hex");
  return Object.freeze({ version, fingerprint, components: Object.freeze(components) });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const version = String(process.argv[2] || "").trim();
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  process.stdout.write(`${JSON.stringify(calculateN30RuntimeFingerprint({ repositoryRoot, version }), null, 2)}\n`);
}

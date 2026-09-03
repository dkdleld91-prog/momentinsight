import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { calculateN30RuntimeFingerprint, N30_RUNTIME_COMPONENTS } from "./naver-shopping-runtime-fingerprint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("calculates a deterministic version plus thirteen-component fingerprint", () => {
  const actual = calculateN30RuntimeFingerprint({ repositoryRoot: root, version: "1.1.21" });
  assert.equal(actual.components.length, 13);
  assert.match(actual.fingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(actual.components.map(({ relativePath }) => relativePath), N30_RUNTIME_COMPONENTS);
  assert.equal(calculateN30RuntimeFingerprint({ repositoryRoot: root, version: "1.1.21" }).fingerprint, actual.fingerprint);
  assert.throws(() => calculateN30RuntimeFingerprint({ repositoryRoot: root, version: "1.1.x" }), /runtime_version_invalid/u);
});

test("native host and PowerShell updater preserve the canonical component order", () => {
  const nativeHost = fs.readFileSync(path.join(root, "scripts/naver-shopping-native-host.mjs"), "utf8");
  const updater = fs.readFileSync(path.join(root, "scripts/windows/update-naver-shopping-chrome-extension.ps1"), "utf8");
  const nativeOrder = [
    "serviceWorkerSha256", "nativeHostSha256", "nativeHostCoreSha256", "localWorkerSha256",
    "localWorkerAuthSha256", "contractSha256", "shoppingRankHandlerSha256", "securitySha256",
    "sourceStatusSha256", "providerRuntimeSha256", "mobileTopFallbackSha256",
    "collectorProviderSha256", "collectorContractSha256",
  ];
  const powerShellOrder = [
    "serviceWorkerHash", "nativeHostHash", "nativeHostCoreHash", "localWorkerHash",
    "localWorkerAuthHash", "localWorkerContractHash", "shoppingRankHandlerHash", "securityHash",
    "sourceStatusHash", "providerRuntimeHash", "mobileTopFallbackHash", "collectorProviderHash",
    "collectorContractHash",
  ];
  const nativeIdentity = nativeHost.match(/\[\n\s*version,([\s\S]*?)\n\s*\]\.join\("\\n"\)/u)?.[1] || "";
  const updaterIdentity = updater.match(/"\$ExpectedVersion`n([^"]+)"/u)?.[1] || "";
  let previous = -1;
  for (const name of nativeOrder) { const index = nativeIdentity.indexOf(name); assert.ok(index > previous, name); previous = index; }
  previous = -1;
  for (const name of powerShellOrder) { const index = updaterIdentity.indexOf(`$${name}`); assert.ok(index > previous, name); previous = index; }
  assert.equal(nativeOrder.length, N30_RUNTIME_COMPONENTS.length);
  assert.equal(powerShellOrder.length, N30_RUNTIME_COMPONENTS.length);
});

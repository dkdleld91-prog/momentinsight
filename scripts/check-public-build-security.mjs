import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const requestedOutput = process.argv[2] || "dist";
const outputDir = path.resolve(root, requestedOutput);
const maxPublicFileBytes = 25 * 1024 * 1024;
const maxTextScanBytes = 5 * 1024 * 1024;
const failures = [];
const files = [];
let configuredScriptHashes = new Set();

const blockedNames = new Set([
  ".env",
  ".gitignore",
  ".npmrc",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "vercel.json",
]);
const blockedExtensions = new Set([
  ".cjs",
  ".crt",
  ".jsx",
  ".key",
  ".log",
  ".map",
  ".mjs",
  ".p12",
  ".pem",
  ".pfx",
  ".sql",
  ".ts",
  ".tsx",
]);
const textExtensions = new Set([".css", ".html", ".js", ".json", ".svg", ".txt", ".xml"]);
const secretPatterns = [
  ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["credential token prefix", /\b(?:ghp|github_pat|glpat|sk_live|sk_test|sb_secret|sbp)_[A-Za-z0-9_-]{16,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  [
    "server secret assignment",
    /\b(?:SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|MI_SUPER_ADMIN_CODE|MI_RANK_CRON_SECRET|CRON_SECRET|NAVER_SEARCHAD_SECRET_KEY|NAVER_OPENAPI_CLIENT_SECRET)\s*[:=]\s*["']?[^\s"'<>]{8,}/,
  ],
  ["source map reference", /sourceMappingURL\s*=/],
  ["embedded source map content", /["']sourcesContent["']\s*:/],
];

function parseCsp(value) {
  const directives = new Map();
  for (const segment of String(value || "").split(";")) {
    const parts = segment.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const [name, ...tokens] = parts;
    directives.set(name.toLowerCase(), tokens);
  }
  return directives;
}

function sha256Source(content) {
  return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

function inlineScripts(html) {
  const scripts = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1] || "";
    if (/\bsrc\s*=/i.test(attributes)) continue;
    scripts.push(match[2] || "");
  }
  return scripts;
}

async function checkDeliveryHeaders() {
  let config;
  try {
    config = JSON.parse(await fs.readFile(path.join(root, "vercel.json"), "utf8"));
  } catch (error) {
    failures.push(`vercel.json: ${error?.message || "invalid configuration"}`);
    return;
  }

  const globalRule = (config.headers || []).find((rule) => rule.source === "/(.*)");
  const headers = new Map((globalRule?.headers || []).map((item) => [item.key.toLowerCase(), item.value]));
  const required = new Map([
    ["cross-origin-opener-policy", "same-origin"],
    ["cross-origin-resource-policy", "same-origin"],
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["x-permitted-cross-domain-policies", "none"],
  ]);
  for (const [name, expected] of required) {
    if (headers.get(name) !== expected) {
      failures.push(`vercel.json: ${name} must be ${expected}`);
    }
  }

  const csp = headers.get("content-security-policy") || "";
  for (const directive of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "script-src-attr 'none'"]) {
    if (!csp.includes(directive)) failures.push(`vercel.json: CSP is missing ${directive}`);
  }

  const reportOnly = headers.get("content-security-policy-report-only") || "";
  if (reportOnly) {
    failures.push("vercel.json: report-only CSP must not replace or weaken the enforced policy");
  }

  const directives = parseCsp(csp);
  const scriptSources = directives.get("script-src") || [];
  const scriptElementSources = directives.get("script-src-elem") || scriptSources;
  if (!scriptSources.length) failures.push("vercel.json: enforced CSP must define script-src");
  for (const sources of [scriptSources, scriptElementSources]) {
    if (sources.includes("'unsafe-inline'")) failures.push("vercel.json: script-src must not allow 'unsafe-inline'");
    if (sources.includes("'unsafe-eval'")) failures.push("vercel.json: script-src must not allow 'unsafe-eval'");
    if (sources.some((token) => ["*", "data:", "blob:", "http:", "https:"].includes(token))) {
      failures.push("vercel.json: script-src must not allow broad executable sources");
    }
  }
  if (directives.has("script-src-elem") && JSON.stringify(scriptElementSources) !== JSON.stringify(scriptSources)) {
    failures.push("vercel.json: script-src-elem must not override the verified script-src policy");
  }

  configuredScriptHashes = new Set(scriptSources.filter((token) => /^'sha256-[A-Za-z0-9+/]+={0,2}'$/.test(token)));
  if (!configuredScriptHashes.size) {
    failures.push("vercel.json: script-src must contain SHA-256 hashes for inline scripts");
  }
  if (scriptSources.some((token) => /^'(?:sha384|sha512|nonce)-/i.test(token))) {
    failures.push("vercel.json: inline scripts must use the audited SHA-256 hash allowlist only");
  }
}

function relative(filePath) {
  return path.relative(outputDir, filePath).split(path.sep).join("/");
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const rel = relative(absolute);
    if (entry.isSymbolicLink()) {
      failures.push(`${rel}: symbolic links are not allowed in the public build`);
      continue;
    }
    if (entry.isDirectory()) {
      await walk(absolute);
      continue;
    }
    if (!entry.isFile()) {
      failures.push(`${rel}: unsupported filesystem entry`);
      continue;
    }
    files.push(absolute);
  }
}

try {
  await checkDeliveryHeaders();
  await walk(outputDir);
} catch (error) {
  console.error(`Public build check blocked: ${error?.message || "output directory is unavailable"}`);
  process.exit(1);
}

for (const required of ["index.html", "home.html", "admin.html", "client.html", "robots.txt", "sitemap.xml"]) {
  if (!files.some((filePath) => relative(filePath) === required)) {
    failures.push(`${required}: required public artifact is missing`);
  }
}

const publicInlineScriptHashes = new Set();
let publicInlineScriptCount = 0;

for (const filePath of files) {
  const rel = relative(filePath);
  const name = path.basename(filePath);
  const extension = path.extname(name).toLowerCase();
  const segments = rel.split("/");
  if (segments.some((segment) => segment.startsWith("."))) {
    failures.push(`${rel}: hidden files or directories are not allowed`);
  }
  if (blockedNames.has(name.toLowerCase()) || blockedExtensions.has(extension)) {
    failures.push(`${rel}: private source or configuration artifact is not publishable`);
  }

  const stat = await fs.stat(filePath);
  if (stat.size > maxPublicFileBytes) {
    failures.push(`${rel}: public artifact exceeds ${maxPublicFileBytes} bytes`);
  }

  if (!textExtensions.has(extension) || stat.size > maxTextScanBytes) continue;
  const content = await fs.readFile(filePath, "utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) failures.push(`${rel}: detected ${label}`);
  }
  if (extension === ".html") {
    if (["admin.html", "client.html"].includes(rel)) {
      const ownerOnlyTaxMarkers = /부가세|mi-vat|data-admin-vat|vat-calculator/i;
      if (ownerOnlyTaxMarkers.test(content) || /Math\.round\([^\n]*\*\s*0\.1\)/.test(content)) {
        failures.push(`${rel}: owner-only calculator content or calculation logic is present in the public page`);
      }
    }
    inlineScripts(content).forEach((script, index) => {
      publicInlineScriptCount += 1;
      const hash = sha256Source(script);
      publicInlineScriptHashes.add(hash);
      if (!configuredScriptHashes.has(hash)) {
        failures.push(`${rel}: inline script ${index + 1} is missing CSP hash ${hash}`);
      }
    });
  }
}

for (const hash of configuredScriptHashes) {
  if (!publicInlineScriptHashes.has(hash)) {
    failures.push(`vercel.json: stale or unverified script-src hash ${hash}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`BLOCK ${failure}`);
  console.error(`Public build check blocked: ${failures.length} issue(s)`);
  process.exit(1);
}

console.log(
  `Public build check passed: ${files.length} file(s), ${publicInlineScriptCount} inline script(s) covered by ${publicInlineScriptHashes.size} unique SHA-256 hash(es), no private artifacts or secret signatures`,
);

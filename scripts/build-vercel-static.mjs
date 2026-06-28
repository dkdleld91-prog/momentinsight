import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceDir = path.join(root, "02_아임웹_적용코드");
const publicDir = path.join(root, "public");
const outputDir = path.join(root, "dist");
const siteUrl = "https://insight.momentlabs.co.kr";

const pages = {
  home: "아임웹_원샷코드_홈페이지형_모먼트인사이트.html",
  admin: "아임웹_원샷코드_관리자형_모먼트인사이트.html",
  client: "아임웹_원샷코드_대시보드형_모먼트인사이트.html",
};

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findPage(fileName) {
  const direct = path.join(sourceDir, fileName);
  if (await exists(direct)) return direct;

  const normalized = fileName.normalize("NFD");
  const files = await fs.readdir(sourceDir);
  const match = files.find((item) => item.normalize("NFD") === normalized);
  if (!match) {
    throw new Error(`배포 대상 HTML 파일을 찾지 못했습니다: ${fileName}`);
  }
  return path.join(sourceDir, match);
}

async function copyDirectory(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(source, target);
    } else if (entry.isFile()) {
      await fs.copyFile(source, target);
    }
  }
}

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

if (await exists(publicDir)) {
  await copyDirectory(publicDir, outputDir);
}

for (const [alias, fileName] of Object.entries(pages)) {
  const source = await findPage(fileName);
  await fs.copyFile(source, path.join(outputDir, `${alias}.html`));
}

await fs.copyFile(await findPage(pages.home), path.join(outputDir, "index.html"));

await fs.writeFile(
  path.join(outputDir, "robots.txt"),
  ["User-agent: *", "Allow: /", `Sitemap: ${siteUrl}/sitemap.xml`, ""].join("\n"),
  "utf8"
);

await fs.writeFile(
  path.join(outputDir, "sitemap.xml"),
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${siteUrl}/</loc></url>`,
    "</urlset>",
    "",
  ].join("\n"),
  "utf8"
);

console.log(JSON.stringify({
  ok: true,
  outputDir: "dist",
  pages: {
    "/": "index.html",
    "/home.html": "home.html",
    "/admin.html": "admin.html",
    "/client.html": "client.html",
  },
}, null, 2));

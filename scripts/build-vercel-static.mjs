import fs from "node:fs/promises";
import path from "node:path";
import { GUIDE_PAGES, SITE_URL, sitemapXml } from "./public-guide-pages.mjs";

const root = process.cwd();
const sourceDir = path.join(root, "src/pages");
const publicDir = path.join(root, "public");
const outputDir = path.join(root, "dist");
const siteUrl = SITE_URL;

const pages = {
  home: "home.html",
  admin: "admin.html",
  client: "client.html",
  privacy: "privacy.html",
  // 없는 주소는 Vercel 기본 문자열 대신 이 안내 페이지(홈·뉴스·가입·로그인 링크)로 답한다(2026-09-07).
  "404": "404.html",
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
  if (await exists(direct)) {
    const stat = await fs.lstat(direct);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`배포 대상 HTML은 일반 파일이어야 합니다: ${fileName}`);
    }
    return direct;
  }

  const normalized = fileName.normalize("NFD");
  const files = await fs.readdir(sourceDir);
  const match = files.find((item) => item.normalize("NFD") === normalized);
  if (!match) {
    throw new Error(`배포 대상 HTML 파일을 찾지 못했습니다: ${fileName}`);
  }
  const matchedPath = path.join(sourceDir, match);
  const stat = await fs.lstat(matchedPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`배포 대상 HTML은 일반 파일이어야 합니다: ${fileName}`);
  }
  return matchedPath;
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
    } else {
      throw new Error(`public 폴더에는 일반 파일과 폴더만 허용됩니다: ${source}`);
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

// 공개 사용 안내 페이지: dist/guide/<slug>.html → cleanUrls 로 /guide/<slug> (2026-10-29)
await fs.mkdir(path.join(outputDir, "guide"), { recursive: true });
for (const page of GUIDE_PAGES) {
  await fs.copyFile(await findPage(page.source), path.join(outputDir, "guide", `${page.slug}.html`));
}

await fs.writeFile(
  path.join(outputDir, "robots.txt"),
  ["User-agent: *", "Allow: /", `Sitemap: ${siteUrl}/sitemap.xml`, ""].join("\n"),
  "utf8"
);

await fs.writeFile(path.join(outputDir, "sitemap.xml"), sitemapXml(siteUrl), "utf8");

console.log(JSON.stringify({
  ok: true,
  outputDir: "dist",
  pages: {
    "/": "index.html",
    "/home.html": "home.html",
    "/admin.html": "admin.html",
    "/client.html": "client.html",
    ...Object.fromEntries(GUIDE_PAGES.map((page) => [`/guide/${page.slug}`, `guide/${page.slug}.html`])),
  },
}, null, 2));

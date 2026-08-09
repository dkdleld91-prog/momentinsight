#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NAVER_SHOPPING_PROFILE_AUTH_MARKER,
  NAVER_SHOPPING_PROFILE_AUTH_MARKER_SCHEMA,
  NAVER_SHOPPING_PROFILE_OWNER_MARKER,
  NAVER_SHOPPING_PROFILE_OWNER_MARKER_VALUE,
  defaultNaverShoppingProfileDir,
} from "../tools/naver-shopping-rank-collector/src/provider.mjs";

const PROFILE_DIRECTORY = defaultNaverShoppingProfileDir();
const OWNER_MARKER_PATH = path.join(PROFILE_DIRECTORY, NAVER_SHOPPING_PROFILE_OWNER_MARKER);
const AUTH_MARKER_PATH = path.join(PROFILE_DIRECTORY, NAVER_SHOPPING_PROFILE_AUTH_MARKER);
const COLLECTOR_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tools/naver-shopping-rank-collector",
);
const PLAYWRIGHT_MODULE = path.join(COLLECTOR_DIRECTORY, "node_modules/playwright/index.mjs");
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const SEARCH_URL = "https://search.shopping.naver.com/ns/search?query=%EC%98%A8%EC%97%B4%EC%B0%9C%EC%A7%88%EA%B8%B0";
const BLOCK_PATTERN = /캡챠|captcha|자동입력\s*방지|로봇이\s*아닙니다|비정상적인\s*접근|이용이\s*제한|access\s*denied/i;

function bootstrapError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function lstatIfPresent(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareDedicatedProfile() {
  const parentDirectory = path.dirname(PROFILE_DIRECTORY);
  const profileStat = await lstatIfPresent(PROFILE_DIRECTORY);
  if (profileStat?.isSymbolicLink()) throw bootstrapError("profile_symlink_not_allowed");
  if (profileStat && !profileStat.isDirectory()) throw bootstrapError("profile_path_invalid");

  await fsp.mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  await fsp.mkdir(PROFILE_DIRECTORY, { recursive: true, mode: 0o700 });
  await fsp.chmod(PROFILE_DIRECTORY, 0o700);

  const ownerMarkerStat = await lstatIfPresent(OWNER_MARKER_PATH);
  if (!ownerMarkerStat) {
    const entries = await fsp.readdir(PROFILE_DIRECTORY);
    if (entries.length) throw bootstrapError("unmarked_profile_not_empty");
    await fsp.writeFile(OWNER_MARKER_PATH, `${NAVER_SHOPPING_PROFILE_OWNER_MARKER_VALUE}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } else {
    if (ownerMarkerStat.isSymbolicLink() || !ownerMarkerStat.isFile()) {
      throw bootstrapError("profile_owner_marker_invalid");
    }
    const ownerMarker = (await fsp.readFile(OWNER_MARKER_PATH, "utf8")).trim();
    if (ownerMarker !== NAVER_SHOPPING_PROFILE_OWNER_MARKER_VALUE) {
      throw bootstrapError("profile_owner_marker_invalid");
    }
    await fsp.chmod(OWNER_MARKER_PATH, 0o600);
  }

  const authMarkerStat = await lstatIfPresent(AUTH_MARKER_PATH);
  if (authMarkerStat?.isSymbolicLink()) throw bootstrapError("profile_auth_marker_invalid");
  if (authMarkerStat) await fsp.unlink(AUTH_MARKER_PATH);
}

async function verifiedShoppingPage(page) {
  if (!page || page.isClosed()) return false;
  let current;
  try {
    current = new URL(page.url());
  } catch {
    return false;
  }
  if (
    current.protocol !== "https:"
    || !["search.shopping.naver.com", "msearch.shopping.naver.com"].includes(current.hostname)
    || current.pathname !== "/ns/search"
  ) return false;
  const snapshot = await page.evaluate(() => ({
    hasNextData: Boolean(document.getElementById("__NEXT_DATA__")?.textContent),
    productLinkCount: Array.from(document.querySelectorAll("a[href]"))
      .filter((anchor) => /(?:\/products\/|\/catalog\/)/u.test(String(anchor.getAttribute("href") || "")))
      .length,
    bodyText: String(document.body?.innerText || "").slice(0, 20_000),
  })).catch(() => ({ hasNextData: false, productLinkCount: 0, bodyText: "" }));
  // A challenge may be solved only by the user in this visible dedicated
  // window. Keep waiting instead of closing the exact window they must use.
  if (BLOCK_PATTERN.test(snapshot.bodyText)) return false;
  return snapshot.hasNextData === true || snapshot.productLinkCount >= 5;
}

async function findVerifiedShoppingPage(context) {
  for (const candidate of context.pages()) {
    if (await verifiedShoppingPage(candidate)) return candidate;
  }
  return null;
}

async function loadChromium() {
  if (!fs.existsSync(PLAYWRIGHT_MODULE)) throw bootstrapError("playwright_dependency_missing");
  const module = await import(pathToFileURL(PLAYWRIGHT_MODULE).href);
  if (!module?.chromium?.launchPersistentContext) throw bootstrapError("playwright_runtime_invalid");
  return module.chromium;
}

async function main() {
  process.umask(0o077);
  await prepareDedicatedProfile();
  const chromium = await loadChromium();
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIRECTORY, {
      headless: false,
      channel: "chromium",
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
    });
    const existingPages = context.pages();
    let page = existingPages[0] || await context.newPage();
    for (const extraPage of existingPages.slice(1)) await extraPage.close().catch(() => {});
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

    console.log("N 쇼핑 전용 창에서 대표님이 직접 로그인해 주세요. ID와 비밀번호는 코드가 읽지 않습니다.");
    console.log("로그인 후 N 쇼핑 검색 결과가 열리면 이 검사가 자동 완료됩니다.");

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const verifiedPage = await findVerifiedShoppingPage(context);
      if (verifiedPage) {
        const marker = {
          schema: NAVER_SHOPPING_PROFILE_AUTH_MARKER_SCHEMA,
          authenticatedAt: new Date().toISOString(),
        };
        await fsp.writeFile(AUTH_MARKER_PATH, `${JSON.stringify(marker)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        console.log("naver_shopping_profile_authenticated");
        return;
      }
      if (page.isClosed()) {
        page = context.pages().find((candidate) => !candidate.isClosed()) || await context.newPage();
        if (page.url() === "about:blank") {
          await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw bootstrapError("naver_login_timeout");
  } finally {
    await context?.close?.().catch(() => {});
  }
}

main().catch((error) => {
  console.error(String(error?.code || error?.message || "profile_bootstrap_failed"));
  process.exitCode = 1;
});

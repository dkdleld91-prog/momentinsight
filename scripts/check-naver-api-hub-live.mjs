import fs from "node:fs";
import path from "node:path";

import {
  isNaverApiHubCutoverReady,
  naverApiErrorMessage,
  naverApiProviderConfig,
  naverDatalabRequest,
  naverSearchRequest,
} from "../src/server/naver-api-hub.mjs";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return acc;
      const index = trimmed.indexOf("=");
      if (index < 1) return acc;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      acc[key] = value;
      return acc;
    }, {});
}

function runtimeEnv() {
  const root = process.cwd();
  return {
    ...loadEnv(path.join(root, "05_네이버_API_연동", ".env.local")),
    ...loadEnv(path.join(root, ".env.local")),
    ...process.env,
  };
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function completedPeriod() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { startDate: dateString(start), endDate: dateString(end) };
}

async function requestJson(label, request, body = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const startedAt = Date.now();
  try {
    const response = await fetch(request.url, {
      method: body ? "POST" : "GET",
      headers: request.headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = { raw: raw.slice(0, 200) };
    }
    if (!response.ok) {
      const error = new Error(naverApiErrorMessage(payload, `${label} HTTP ${response.status}`));
      error.status = response.status;
      throw error;
    }
    return {
      label,
      ok: true,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      resultCount: Array.isArray(payload?.results)
        ? payload.results.reduce((sum, item) => sum + (Array.isArray(item?.data) ? item.data.length : 0), 0)
        : Array.isArray(payload?.items)
          ? payload.items.length
          : 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const env = runtimeEnv();
const config = naverApiProviderConfig(env);
if (!isNaverApiHubCutoverReady(config)) {
  console.error(JSON.stringify({
    ok: false,
    mode: config.mode,
    message: "NAVER API Hub must have a complete key pair and NAVER_API_HUB_MODE=hub",
  }, null, 2));
  process.exit(1);
}

const period = completedPeriod();
const checks = [];
try {
  checks.push(await requestJson(
    "search_blog",
    naverSearchRequest(config, "blog", new URLSearchParams({ query: "모먼트인사이트", display: "1", start: "1" })),
  ));
  checks.push(await requestJson(
    "search_trend",
    naverDatalabRequest(config, "search-trend"),
    {
      ...period,
      timeUnit: "date",
      keywordGroups: [{ groupName: "온열찜질기", keywords: ["온열찜질기"] }],
    },
  ));
  checks.push(await requestJson(
    "shopping_insight_age",
    naverDatalabRequest(config, "shopping-insight-keyword", "age"),
    {
      ...period,
      timeUnit: "month",
      category: "50000008",
      keyword: "온열찜질기",
      device: "",
      gender: "",
      ages: [],
    },
  ));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    mode: config.mode,
    checks,
    failure: {
      message: String(error?.message || "naver_api_hub_live_check_failed"),
      status: Number(error?.status || 0),
    },
  }, null, 2));
  process.exit(1);
}

const ok = checks.length === 3 && checks.every((item) => item.ok && item.resultCount > 0);
console.log(JSON.stringify({
  ok,
  mode: config.mode,
  provider: "naver_api_hub",
  checkedAt: new Date().toISOString(),
  checks,
}, null, 2));
if (!ok) process.exit(1);

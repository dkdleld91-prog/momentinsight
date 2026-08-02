import crypto from "node:crypto";
import { spawn } from "node:child_process";

import {
  RANK_EVIDENCE,
  SCHEMA_VERSION,
  SOURCE,
  validateProviderWindow,
} from "./contract.mjs";
import {
  appendNormalizedPage,
  buildNaverShoppingFrontendUrl,
  buildNaverShoppingSearchUrl,
  classifyNaverPage,
  parseNaverFrontendPage,
  ProviderError,
} from "./provider.mjs";

const SAFARI_DRIVER_PORT = 4_445;
const SAFARI_DRIVER_URL = `http://127.0.0.1:${SAFARI_DRIVER_PORT}`;
const PAGE_SIZE = 40;
const MAX_PAGES = 8;

function normalized(value, max = 160) {
  return String(value ?? "").trim().slice(0, max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function identityDigest(items) {
  const identities = items.map((item) => [
    item.sellerProductId || "",
    item.catalogId || "",
    item.productId || "",
    item.link || "",
  ].join("|")).join("\n");
  return crypto.createHash("sha256").update(identities, "utf8").digest("hex").slice(0, 20);
}

export function assertGitHubMacOsSafariRunner(env = process.env) {
  if (
    normalized(env.GITHUB_ACTIONS).toLowerCase() !== "true"
    || normalized(env.RUNNER_ENVIRONMENT).toLowerCase() !== "github-hosted"
    || normalized(env.RUNNER_OS).toLowerCase() !== "macos"
  ) {
    throw new ProviderError("github_macos_safari_runner_required");
  }
  return true;
}

async function webdriverRequest(fetchImpl, baseUrl, method, path, body) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderError("safari_webdriver_invalid_response");
  }
  if (!response.ok || payload?.value?.error) {
    throw new ProviderError(
      "safari_webdriver_command_failed",
      normalized(payload?.value?.error || payload?.value?.message || response.status, 500),
    );
  }
  return payload;
}

export class SafariWebDriverClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || SAFARI_DRIVER_URL;
    this.fetchImpl = options.fetchImpl || fetch;
    this.sessionId = "";
  }

  async start() {
    const payload = await webdriverRequest(this.fetchImpl, this.baseUrl, "POST", "/session", {
      capabilities: {
        alwaysMatch: {
          browserName: "safari",
          acceptInsecureCerts: false,
          "safari:automaticInspection": false,
          "safari:automaticProfiling": false,
        },
      },
    });
    this.sessionId = normalized(payload?.value?.sessionId || payload?.sessionId, 200);
    if (!this.sessionId) throw new ProviderError("safari_webdriver_session_missing");
    await this.command("POST", "/timeouts", {
      implicit: 0,
      pageLoad: 45_000,
      script: 45_000,
    });
  }

  async command(method, path, body) {
    if (!this.sessionId) throw new ProviderError("safari_webdriver_session_missing");
    const payload = await webdriverRequest(
      this.fetchImpl,
      this.baseUrl,
      method,
      `/session/${encodeURIComponent(this.sessionId)}${path}`,
      body,
    );
    return payload?.value;
  }

  async navigate(url) {
    await this.command("POST", "/url", { url });
  }

  async snapshot() {
    return this.command("POST", "/execute/sync", {
      script: `return {
        userAgent: String(navigator.userAgent || ""),
        nextDataText: String(document.getElementById("__NEXT_DATA__")?.textContent || ""),
        bodyText: String(document.body?.innerText || "").slice(0, 120000),
        title: String(document.title || ""),
        url: String(location.href || "")
      };`,
      args: [],
    });
  }

  async fetchFrontend(requestPath, timeoutMs = 30_000) {
    return this.command("POST", "/execute/async", {
      script: `const requestPath = arguments[0];
        const timeout = arguments[1];
        const done = arguments[arguments.length - 1];
        if (typeof window.ncaptcha?.f === "function") {
          done({ status: 418, url: String(location.href || ""), contentType: "text/plain", bodyText: "CAPTCHA" });
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        fetch(requestPath, {
          method: "GET",
          credentials: "include",
          headers: { accept: "application/json, text/plain, */*", logic: "PART" },
          signal: controller.signal
        }).then(async (response) => {
          const bodyText = await response.text();
          clearTimeout(timer);
          done({
            status: response.status,
            url: response.url,
            contentType: response.headers.get("content-type") || "",
            bodyText
          });
        }).catch((error) => {
          clearTimeout(timer);
          done({ error: String(error?.name || error?.message || "safari_fetch_failed") });
        });`,
      args: [requestPath, timeoutMs],
    });
  }

  async close() {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = "";
    await webdriverRequest(
      this.fetchImpl,
      this.baseUrl,
      "DELETE",
      `/session/${encodeURIComponent(sessionId)}`,
    ).catch(() => {});
  }
}

export async function startSafariDriver(options = {}) {
  const port = Number(options.port || SAFARI_DRIVER_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn("/usr/bin/safaridriver", ["-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  const capture = (chunk) => {
    diagnostics = `${diagnostics}${String(chunk || "")}`.slice(-4_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode != null) {
      throw new ProviderError("safari_driver_start_failed", diagnostics);
    }
    try {
      const response = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return { child, baseUrl };
    } catch {
      // The driver starts asynchronously on GitHub's macOS runner.
    }
    await sleep(250);
  }
  child.kill("SIGTERM");
  throw new ProviderError("safari_driver_start_timeout", diagnostics);
}

export async function collectGitHubSafariWindow(options = {}) {
  const env = options.env || process.env;
  assertGitHubMacOsSafariRunner(env);
  const keyword = normalized(
    options.keyword || env.MI_NAVER_SHOPPING_CLOUD_CANARY_KEYWORD || "온열찜질기",
    100,
  ).normalize("NFC");
  const limit = Number(options.limit || 300);
  if (!keyword || limit !== 300) throw new ProviderError("safari_canary_request_invalid");

  let driverProcess = null;
  let client = options.client;
  const ownsClient = !client;
  try {
    if (!client) {
      const driver = await startSafariDriver();
      driverProcess = driver.child;
      client = new SafariWebDriverClient({ baseUrl: driver.baseUrl });
    }
    await client.start();
    await client.navigate(buildNaverShoppingSearchUrl(keyword, 1));
    const snapshot = await client.snapshot();
    classifyNaverPage({
      status: 200,
      url: snapshot?.url,
      title: snapshot?.title,
      bodyText: snapshot?.bodyText,
      rowCount: 0,
    });

    const userAgent = normalized(snapshot?.userAgent, 500);
    if (!/safari/i.test(userAgent) || /(?:chrome|chromium)/i.test(userAgent)) {
      throw new ProviderError("safari_user_agent_not_verified", userAgent);
    }

    const state = { items: [], identities: new Set(), rawCount: 0, excludedAdCount: 0 };
    let marketTotal = null;
    let marketTotalVerified = true;
    let sourceExhausted = false;

    for (let pageIndex = 1; pageIndex <= MAX_PAGES && state.items.length < limit; pageIndex += 1) {
      const frontendUrl = new URL(buildNaverShoppingFrontendUrl(keyword, pageIndex));
      const response = await client.fetchFrontend(`${frontendUrl.pathname}${frontendUrl.search}`);
      if (response?.error) throw new ProviderError("safari_frontend_fetch_failed", response.error);
      classifyNaverPage({
        status: Number(response?.status || 0),
        url: response?.url || frontendUrl.toString(),
        bodyText: response?.bodyText || "",
        rowCount: 0,
      });
      if (!/application\/json/i.test(String(response?.contentType || ""))) {
        throw new ProviderError("naver_frontend_schema_drift", "content-type");
      }
      const parsed = parseNaverFrontendPage(response.bodyText, {
        pageIndex,
        pageSize: PAGE_SIZE,
        keyword,
      });
      if (parsed.marketTotal != null && marketTotalVerified) {
        if (marketTotal != null && marketTotal !== parsed.marketTotal) {
          marketTotalVerified = false;
          marketTotal = null;
        } else {
          marketTotal = parsed.marketTotal;
        }
      }
      const before = state.items.length;
      appendNormalizedPage(state, parsed, { pageIndex, limit });
      sourceExhausted = parsed.sourceExhausted === true;
      if (state.items.length === before && !sourceExhausted) {
        throw new ProviderError("naver_selector_drift", `page:${pageIndex}:no_new_rows`);
      }
    }

    if (state.items.length !== limit) {
      throw new ProviderError("provider_partial_window", `${state.items.length}/${limit}`);
    }
    const collectedAt = new Date(options.nowMs?.() ?? Date.now()).toISOString();
    const runId = normalized(env.GITHUB_RUN_ID, 40);
    const runAttempt = normalized(env.GITHUB_RUN_ATTEMPT || "1", 10);
    if (!/^\d+$/u.test(runId) || !/^\d+$/u.test(runAttempt)) {
      throw new ProviderError("github_cloud_run_identity_invalid");
    }
    const request = { keyword, limit };
    const window = {
      ok: true,
      schemaVersion: SCHEMA_VERSION,
      keyword,
      source: SOURCE,
      rankEvidence: RANK_EVIDENCE,
      collectionId: `ghsafari-${runId}-${runAttempt}-${identityDigest(state.items)}`,
      collectedAt,
      complete: true,
      partial: false,
      sourceExhausted,
      marketTotal: marketTotalVerified ? marketTotal : null,
      marketTotalStatus: marketTotalVerified && marketTotal != null ? "verified" : "unavailable",
      checkedCount: state.items.length,
      rawCount: state.rawCount,
      excludedAdCount: state.excludedAdCount,
      items: state.items,
    };
    return {
      window: validateProviderWindow(window, request),
      browser: "Safari",
      userAgent,
    };
  } finally {
    if (ownsClient) await client?.close?.().catch(() => {});
    driverProcess?.kill("SIGTERM");
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { allowedOrigins, corsHeaders, isLocalRequest } from "./security.mjs";

test("production never trusts a spoofed localhost host", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVercelEnv = process.env.VERCEL_ENV;
  try {
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";
    assert.equal(isLocalRequest(new Request("http://localhost/api/test")), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
  }
});

test("local development still recognizes loopback requests", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVercelEnv = process.env.VERCEL_ENV;
  try {
    process.env.NODE_ENV = "development";
    delete process.env.VERCEL_ENV;
    assert.equal(isLocalRequest(new Request("http://127.0.0.1:8784/api/test")), true);
    assert.equal(isLocalRequest(new Request("https://insight.momentlabs.co.kr/api/test")), false);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
  }
});

test("API responses carry isolation and active-content defense headers", () => {
  const headers = corsHeaders(new Request("https://insight.momentlabs.co.kr/api/health"));
  assert.equal(headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(headers["x-permitted-cross-domain-policies"], "none");
  assert.match(headers["content-security-policy"], /object-src 'none'/);
  assert.match(headers["content-security-policy"], /script-src-attr 'none'/);
  assert.equal(headers["cache-control"], "no-store");
});

test("production CORS excludes localhost and wildcard origins", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVercelEnv = process.env.VERCEL_ENV;
  const previousAllowed = process.env.MI_ALLOWED_ORIGINS;
  try {
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";
    process.env.MI_ALLOWED_ORIGINS = "*,http://localhost:8790,https://insight.momentlabs.co.kr";
    assert.deepEqual(allowedOrigins(), ["https://insight.momentlabs.co.kr"]);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
    if (previousAllowed === undefined) delete process.env.MI_ALLOWED_ORIGINS;
    else process.env.MI_ALLOWED_ORIGINS = previousAllowed;
  }
});

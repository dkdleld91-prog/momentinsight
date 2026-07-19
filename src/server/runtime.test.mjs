import assert from "node:assert/strict";
import test from "node:test";
import { createHandlerResolver, executeRequest } from "./runtime.mjs";
import { corsHeaders } from "./security.mjs";

test("handler resolver shares successful loads and retries a rejected import", async () => {
  let attempts = 0;
  const resolve = createHandlerResolver({
    sample: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary import failure");
      return { default: { fetch: () => Response.json({ ok: true }) } };
    },
  });

  await assert.rejects(resolve("sample"), /temporary import failure/);
  const [left, right] = await Promise.all([resolve("sample"), resolve("sample")]);
  assert.equal(attempts, 2);
  assert.equal(left, right);
});

test("request runtime returns a sanitized error with a trace id", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await executeRequest(new Request("https://insight.momentlabs.co.kr/api/test", {
      headers: { "x-request-id": "request-safe-1234" },
    }), async () => {
      throw new Error("SUPABASE_SECRET_KEY=do-not-leak");
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("x-request-id"), "request-safe-1234");
    assert.equal(body.requestId, "request-safe-1234");
    assert.doesNotMatch(JSON.stringify(body), /SUPABASE|do-not-leak/);
  } finally {
    console.error = originalError;
  }
});

test("request runtime strips database schema details returned by handlers", async () => {
  const response = await executeRequest(new Request("https://insight.momentlabs.co.kr/api/report-center", {
    headers: { "x-request-id": "request-db-safe-1234" },
  }), async () => Response.json({
    ok: false,
    message: "보고서 조회에 실패했습니다.",
    detail: "column reports.workflow_status does not exist",
  }, { status: 500 }));

  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.code, "SERVER_ERROR");
  assert.equal(body.requestId, "request-db-safe-1234");
  assert.doesNotMatch(JSON.stringify(body), /workflow_status|column reports|detail/);
});

test("request runtime removes wildcard CORS and keeps an approved origin", async () => {
  const handler = async () => new Response("ok", {
    headers: { "access-control-allow-origin": "*" },
  });
  const denied = await executeRequest(new Request("https://insight.momentlabs.co.kr/api/test", {
    headers: { origin: "https://attacker.example" },
  }), handler);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  const approved = await executeRequest(new Request("https://insight.momentlabs.co.kr/api/test", {
    headers: { origin: "https://insight.momentlabs.co.kr" },
  }), handler);
  assert.equal(approved.headers.get("access-control-allow-origin"), "https://insight.momentlabs.co.kr");
});

test("request runtime applies clickjacking and browser capability protections", async () => {
  const response = await executeRequest(
    new Request("https://insight.momentlabs.co.kr/api/test"),
    async () => Response.json({ ok: true }),
  );

  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.match(response.headers.get("permissions-policy") || "", /camera=\(\)/);
});

test("request runtime cannot weaken the central response security policy", async () => {
  const request = new Request("https://insight.momentlabs.co.kr/api/test");
  const response = await executeRequest(request, async () => Response.json({ ok: true }, {
    headers: {
      "content-security-policy": "default-src *",
      "cross-origin-opener-policy": "unsafe-none",
      "cross-origin-resource-policy": "cross-origin",
      "permissions-policy": "camera=*",
      "strict-transport-security": "max-age=0",
      "x-permitted-cross-domain-policies": "all",
    },
  }));
  const expected = corsHeaders(request);

  for (const name of [
    "cache-control",
    "content-security-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "origin-agent-cluster",
    "permissions-policy",
    "referrer-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
    "x-permitted-cross-domain-policies",
  ]) {
    assert.equal(response.headers.get(name), expected[name], name);
  }
});

test("request runtime preserves bodyless protocol responses", async () => {
  for (const status of [204, 205, 304]) {
    const response = await executeRequest(
      new Request("https://insight.momentlabs.co.kr/api/session", { method: "OPTIONS" }),
      async () => new Response(null, { status }),
    );

    assert.equal(response.status, status);
    assert.equal(await response.text(), "");
  }
});

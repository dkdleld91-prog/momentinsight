import assert from "node:assert/strict";
import test from "node:test";

import { createCollectorServer, MAX_BODY_BYTES } from "../src/app.mjs";
import { RANK_EVIDENCE, SCHEMA_VERSION, SOURCE } from "../src/contract.mjs";

const SECRET = "test-only-secret-with-enough-entropy";

function validWindow(limit = 2) {
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    keyword: "온열찜질기",
    source: SOURCE,
    rankEvidence: RANK_EVIDENCE,
    collectionId: "fixture-collection-001",
    collectedAt: "2026-08-01T00:00:00.000Z",
    complete: true,
    partial: false,
    sourceExhausted: false,
    marketTotal: 320,
    marketTotalStatus: "verified",
    checkedCount: limit,
    rawCount: limit + 3,
    excludedAdCount: 3,
    items: Array.from({ length: limit }, (_, index) => ({
      organicRank: index + 1,
      isAd: false,
      isOrganic: true,
      productId: String(12000000000 + index),
      sellerProductId: String(5145848584 + index),
      title: `검증 상품 ${index + 1}`,
      link: `https://smartstore.naver.com/example/products/${5145848584 + index}`,
      mallName: "검증 판매처",
      productType: 1,
    })),
  };
}

function readyProvider(collect = async (request) => validWindow(request.limit)) {
  return {
    async status() {
      return { name: "fixture", configured: true, verified: true, reason: "" };
    },
    collect,
  };
}

async function withServer(provider, run) {
  const server = createCollectorServer({
    secret: SECRET,
    provider,
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function rankRequest(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    keyword: "온열찜질기",
    limit: 2,
    sort: "relevance",
    rankPolicy: "organic_only",
    deadlineAt: "2026-08-01T00:00:40.000Z",
    ...overrides,
  };
}

function post(baseUrl, body, { token = SECRET, raw = false } = {}) {
  return fetch(`${baseUrl}/rank/naver-shopping`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: raw ? body : JSON.stringify(body),
  });
}

test("rejects missing and incorrect bearer tokens before calling the provider", async () => {
  let calls = 0;
  await withServer(readyProvider(async () => {
    calls += 1;
    return validWindow();
  }), async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/rank/naver-shopping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rankRequest()),
    });
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).message, "unauthorized");

    const wrong = await post(baseUrl, rankRequest(), { token: "wrong-secret" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("access-control-allow-origin"), null);
    assert.equal(calls, 0);
  });
});

test("rejects malformed, unexpected, oversize, and out-of-range requests", async () => {
  await withServer(readyProvider(), async (baseUrl) => {
    const malformed = await post(baseUrl, "{", { raw: true });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).message, "invalid_json");

    const unexpected = await post(baseUrl, rankRequest({ start: 1 }));
    assert.equal(unexpected.status, 400);
    assert.equal((await unexpected.json()).detail, "unexpected:start");

    const outOfRange = await post(baseUrl, rankRequest({ limit: 301 }));
    assert.equal(outOfRange.status, 400);
    assert.equal((await outOfRange.json()).detail, "limit");

    const longKeyword = await post(baseUrl, rankRequest({ keyword: "가".repeat(101) }));
    assert.equal(longKeyword.status, 400);
    assert.equal((await longKeyword.json()).detail, "keyword");

    const oversize = await post(baseUrl, "x".repeat(MAX_BODY_BYTES + 1), { raw: true });
    assert.equal(oversize.status, 413);
    assert.equal((await oversize.json()).message, "request_too_large");
  });
});

test("fails closed for incomplete, untrusted, or ad-contaminated provider windows", async (t) => {
  const cases = [
    ["incomplete", {
      complete: false,
      partial: true,
      sourceExhausted: false,
      checkedCount: 1,
      rawCount: 4,
      items: [validWindow().items[0]],
    }, "provider_response_incomplete"],
    ["wrong source", { source: "legacy_search_api" }, "provider_response_untrusted"],
    ["wrong evidence", { rankEvidence: "mixed_search_block" }, "provider_response_untrusted"],
    ["advertisement", {
      items: [
        { ...validWindow().items[0], isAd: true },
        validWindow().items[1],
      ],
    }, "provider_response_untrusted"],
    ["duplicate stable product id", {
      items: [
        validWindow().items[0],
        { ...validWindow().items[1], productId: validWindow().items[0].productId },
      ],
    }, "provider_response_untrusted"],
  ];

  for (const [name, overrides, expectedMessage] of cases) {
    await t.test(name, async () => {
      await withServer(readyProvider(async () => ({ ...validWindow(), ...overrides })), async (baseUrl) => {
        const response = await post(baseUrl, rankRequest());
        assert.equal(response.status, 502);
        assert.equal((await response.json()).message, expectedMessage);
      });
    });
  }
});

test("accepts a complete short window only when the provider proves source exhaustion", async () => {
  await withServer(readyProvider(async () => ({
    ...validWindow(1),
    sourceExhausted: true,
    marketTotal: 1,
    rawCount: 4,
  })), async (baseUrl) => {
    const response = await post(baseUrl, rankRequest({ limit: 2 }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.complete, true);
    assert.equal(body.partial, false);
    assert.equal(body.sourceExhausted, true);
    assert.equal(body.checkedCount, 1);
  });
});

test("accepts distinct catalog and seller results that share one parent catalog", async () => {
  const sharedCatalogId = "71000000001";
  const window = validWindow();
  window.items = [
    {
      organicRank: 1,
      isAd: false,
      isOrganic: true,
      productId: "91000000001",
      catalogId: sharedCatalogId,
      title: "검증 원부",
      productType: 1,
    },
    {
      organicRank: 2,
      isAd: false,
      isOrganic: true,
      productId: "91000000002",
      sellerProductId: "12000000002",
      catalogId: sharedCatalogId,
      linkedCatalogId: sharedCatalogId,
      title: "검증 판매처 상품",
      link: "https://smartstore.naver.com/example/products/12000000002",
      productType: 3,
    },
  ];

  await withServer(readyProvider(async () => window), async (baseUrl) => {
    const response = await post(baseUrl, rankRequest());
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.items.length, 2);
    assert.equal(payload.items[0].catalogId, sharedCatalogId);
    assert.equal(payload.items[1].linkedCatalogId, sharedCatalogId);
  });
});

test("reports liveness separately from verified readiness", async () => {
  const provider = {
    async status() {
      return {
        name: "unconfigured",
        configured: false,
        verified: false,
        reason: "verified_provider_not_configured",
      };
    },
    async collect() {
      throw new Error("must_not_run");
    },
  };
  await withServer(provider, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ready, false);

    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).ok, false);
  });
});

test("an authenticated rank request waits for one configured provider readiness check", async () => {
  let verified = false;
  let verificationCalls = 0;
  let collectionCalls = 0;
  const provider = {
    async status() {
      return {
        name: "warming-fixture",
        configured: true,
        verified,
        reason: verified ? "" : "startup_canary_pending",
      };
    },
    async verifyReadiness() {
      verificationCalls += 1;
      verified = true;
      return true;
    },
    async collect(request) {
      collectionCalls += 1;
      return validWindow(request.limit);
    },
  };

  await withServer(provider, async (baseUrl) => {
    const response = await post(baseUrl, rankRequest());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).checkedCount, 2);
  });

  assert.equal(verificationCalls, 1);
  assert.equal(collectionCalls, 1);
});

test("returns only a validated atomic organic window from an injected provider", async () => {
  let received;
  await withServer(readyProvider(async (request) => {
    received = request;
    return validWindow(request.limit);
  }), async (baseUrl) => {
    const response = await post(baseUrl, rankRequest({ requestId: "req-001" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = await response.json();
    assert.equal(body.schemaVersion, SCHEMA_VERSION);
    assert.equal(body.complete, true);
    assert.equal(body.checkedCount, 2);
    assert.equal(body.items[0].organicRank, 1);
    assert.equal(body.items[1].organicRank, 2);
    assert.equal(body.items.every((item) => item.isAd === false), true);
    assert.deepEqual(received, rankRequest({ requestId: "req-001" }));
  });
});

test("keeps a complete organic window when the optional market total is unavailable", async () => {
  await withServer(readyProvider(async () => ({
    ...validWindow(),
    marketTotal: null,
    marketTotalStatus: "unavailable",
  })), async (baseUrl) => {
    const response = await post(baseUrl, rankRequest());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.complete, true);
    assert.equal(body.checkedCount, 2);
    assert.equal(body.marketTotal, null);
    assert.equal(body.marketTotalStatus, "unavailable");
  });
});

test("reports request-local queue pressure as retryable provider busy", async (t) => {
  for (const code of ["provider_queue_full", "provider_queue_deadline_exceeded"]) {
    await t.test(code, async () => {
      const error = new Error(code);
      error.code = code;
      await withServer(readyProvider(async () => {
        throw error;
      }), async (baseUrl) => {
        const response = await post(baseUrl, rankRequest());
        assert.equal(response.status, 429);
        assert.deepEqual(await response.json(), {
          ok: false,
          schemaVersion: SCHEMA_VERSION,
          message: "provider_busy",
          detail: code,
        });
      });
    });
  }
});

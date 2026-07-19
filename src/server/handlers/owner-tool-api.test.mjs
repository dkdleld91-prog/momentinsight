import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import app, { calculateOwnerTax } from "./owner-tool-api.mjs";

function request(method = "GET", options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.owner !== false) {
    headers.set("x-mi-session-role", options.role || "owner");
    headers.set("x-mi-owner-agency-code", options.ownerCode || "mml93-a01");
  }
  return new Request("https://insight.momentlabs.co.kr/api/owner/tool", {
    method,
    headers,
    body: options.body,
  });
}

test("calculation uses integer half-up tax rounding", () => {
  assert.deepEqual(calculateOwnerTax("1000000"), { supply: 1_000_000, tax: 100_000, total: 1_100_000 });
  assert.deepEqual(calculateOwnerTax("15"), { supply: 15, tax: 2, total: 17 });
  assert.deepEqual(calculateOwnerTax("0"), { supply: 0, tax: 0, total: 0 });
  assert.equal(calculateOwnerTax("1,000"), null);
  assert.equal(calculateOwnerTax("1000000000000000"), null);
  assert.equal(calculateOwnerTax(-1), null);
});

test("tool content is disclosed only to the exact primary owner identity", async () => {
  const anonymous = await app.fetch(request("GET", { owner: false }));
  const team = await app.fetch(request("GET", { role: "team" }));
  const wrongOwner = await app.fetch(request("GET", { ownerCode: "mml93-a02" }));
  assert.equal(anonymous.status, 403);
  assert.equal(team.status, 403);
  assert.equal(wrongOwner.status, 403);

  const owner = await app.fetch(request());
  const payload = await owner.json();
  assert.equal(owner.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.tool.screen, "owner-utility");
  assert.match(payload.tool.menuHtml, /부가세 계산기/);
  assert.match(payload.tool.viewHtml, /data-owner-tool-input/);
  assert.match(payload.tool.styleText, /mi-vat-layout/);
});

test("calculation endpoint rejects non-owner, wrong media and invalid amounts", async () => {
  const body = JSON.stringify({ action: "calculate", supply: "1000000" });
  const blocked = await app.fetch(request("POST", {
    role: "client",
    headers: { "content-type": "application/json" },
    body,
  }));
  assert.equal(blocked.status, 403);

  const wrongMedia = await app.fetch(request("POST", { body }));
  assert.equal(wrongMedia.status, 415);

  const invalid = await app.fetch(request("POST", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "calculate", supply: "1e6" }),
  }));
  assert.equal(invalid.status, 400);

  const valid = await app.fetch(request("POST", {
    headers: { "content-type": "application/json" },
    body,
  }));
  assert.equal(valid.status, 200);
  assert.deepEqual((await valid.json()).amounts, { supply: 1_000_000, tax: 100_000, total: 1_100_000 });
});

test("public page sources contain no owner-only tax markup, styles or calculation formula", () => {
  const sources = ["src/pages/admin.html", "src/pages/client.html"].map((file) => fs.readFileSync(file, "utf8"));
  for (const source of sources) {
    assert.doesNotMatch(source, /부가세|mi-vat|data-admin-vat|vat-calculator/i);
    assert.doesNotMatch(source, /Math\.round\([^\n]*\*\s*0\.1\)/);
  }
  assert.match(sources[0], /\/api\/owner\/tool/);
  assert.match(sources[0], /loadOwnerTool/);
});

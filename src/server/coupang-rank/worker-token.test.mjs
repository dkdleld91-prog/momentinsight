import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  collectorTokenHash,
  generateCollectorToken,
  parseBearer,
  verifyCollectorToken,
} from "./worker-token.mjs";
import { COLLECTOR_TOKEN_PATTERN } from "./contract.mjs";

const TOKEN = `mic1_${"A".repeat(21)}-_${"z".repeat(20)}`;

function fakeCtx(result) {
  const calls = [];
  const query = {
    select(columns) { calls.push(["select", columns]); return query; },
    eq(column, value) { calls.push(["eq", column, value]); return query; },
    async maybeSingle() { calls.push(["maybeSingle"]); return typeof result === "function" ? result() : result; },
  };
  return {
    calls,
    ctx: { supabaseAdmin: { from(table) { calls.push(["from", table]); return query; } } },
  };
}

function requestWith(authorization) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("https://insight.momentlabs.co.kr/api/coupang-rank-worker", { method: "POST", headers, body: "{}" });
}

test("연결 코드 형식: mic1_ + base64url 43자", () => {
  assert.equal(TOKEN.length, 48);
  assert.equal(COLLECTOR_TOKEN_PATTERN.test(TOKEN), true);
  for (let index = 0; index < 20; index += 1) {
    const { token, tokenSha256, tokenHint } = generateCollectorToken();
    assert.match(token, /^mic1_[A-Za-z0-9_-]{43}$/);
    assert.equal(COLLECTOR_TOKEN_PATTERN.test(token), true);
    assert.equal(tokenSha256, createHash("sha256").update(token, "utf8").digest("hex"));
    assert.match(tokenSha256, /^[0-9a-f]{64}$/);
    assert.equal(tokenHint, token.slice(-4));
    assert.equal(tokenHint.length, 4);
  }
  const first = generateCollectorToken().token;
  const second = generateCollectorToken().token;
  assert.notEqual(first, second);
});

test("collectorTokenHash 는 sha256 소문자 hex", () => {
  assert.equal(collectorTokenHash(TOKEN), createHash("sha256").update(TOKEN).digest("hex"));
  assert.equal(collectorTokenHash(TOKEN), collectorTokenHash(TOKEN));
  assert.notEqual(collectorTokenHash(TOKEN), collectorTokenHash(`${TOKEN.slice(0, -1)}B`));
});

test("parseBearer 는 정확히 'Bearer mic1_<43자>' 만 받는다", () => {
  assert.equal(parseBearer(`Bearer ${TOKEN}`), TOKEN);
  for (const header of [
    undefined,
    null,
    "",
    TOKEN,
    `bearer ${TOKEN}`,
    `BEARER ${TOKEN}`,
    `Bearer  ${TOKEN}`,
    `Bearer ${TOKEN} `,
    ` Bearer ${TOKEN}`,
    `Bearer ${TOKEN.slice(0, -1)}`,
    `Bearer ${TOKEN}A`,
    `Bearer mic2_${TOKEN.slice(5)}`,
    `Bearer ${TOKEN.slice(0, -1)}=`,
    `Bearer ${TOKEN.slice(0, -1)}+`,
    `Bearer ${TOKEN}\n`,
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
    12345,
  ]) {
    assert.equal(parseBearer(header), null, JSON.stringify(header));
  }
});

test("verifyCollectorToken: 형식이 틀리면 DB 를 조회하지 않고 401", async () => {
  const { ctx, calls } = fakeCtx({ data: null, error: null });
  for (const header of [undefined, "Bearer short", `Basic ${TOKEN}`]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await verifyCollectorToken(ctx, requestWith(header));
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.code, "COLLECTOR_AUTH_REJECTED");
  }
  assert.equal(calls.length, 0);
});

test("verifyCollectorToken: 해시로 조회하고 통과하면 해시를 뺀 행을 돌려준다", async () => {
  const hash = collectorTokenHash(TOKEN);
  const row = { id: "c1", label: "윈도우 데스크탑", token_sha256: hash, token_hint: TOKEN.slice(-4), revoked_at: null };
  const { ctx, calls } = fakeCtx({ data: row, error: null });
  const result = await verifyCollectorToken(ctx, requestWith(`Bearer ${TOKEN}`));
  assert.equal(result.ok, true);
  assert.equal(result.tokenHash, hash);
  assert.equal(result.collector.id, "c1");
  assert.equal("token_sha256" in result.collector, false);
  assert.deepEqual(calls.find((call) => call[0] === "eq"), ["eq", "token_sha256", hash]);
  assert.deepEqual(calls[0], ["from", "coupang_rank_collectors"]);
  assert.equal(JSON.stringify(calls).includes(TOKEN), false, "원문 코드는 DB 로 보내지 않는다");
});

test("verifyCollectorToken: 없음·폐기·해시 불일치는 401, 표 없음은 503, 그 밖의 오류는 던진다", async () => {
  const hash = collectorTokenHash(TOKEN);
  const request = () => requestWith(`Bearer ${TOKEN}`);

  const none = await verifyCollectorToken(fakeCtx({ data: null, error: null }).ctx, request());
  assert.equal(none.status, 401);

  const revoked = await verifyCollectorToken(fakeCtx({
    data: { id: "c1", token_sha256: hash, revoked_at: "2026-10-16T00:00:00Z" }, error: null,
  }).ctx, request());
  assert.equal(revoked.status, 401);
  assert.equal(revoked.code, "COLLECTOR_AUTH_REJECTED");

  const mismatch = await verifyCollectorToken(fakeCtx({
    data: { id: "c1", token_sha256: "0".repeat(64), revoked_at: null }, error: null,
  }).ctx, request());
  assert.equal(mismatch.status, 401);

  const badStored = await verifyCollectorToken(fakeCtx({
    data: { id: "c1", token_sha256: hash.toUpperCase(), revoked_at: null }, error: null,
  }).ctx, request());
  assert.equal(badStored.status, 401);

  for (const code of ["42P01", "PGRST205"]) {
    // eslint-disable-next-line no-await-in-loop
    const setup = await verifyCollectorToken(fakeCtx({ data: null, error: { code, message: "relation missing" } }).ctx, request());
    assert.equal(setup.status, 503);
    assert.equal(setup.code, "COUPANG_SETUP_REQUIRED");
  }

  await assert.rejects(
    verifyCollectorToken(fakeCtx({ data: null, error: { code: "57014", message: "secret db text" } }).ctx, request()),
    (error) => error.code === "57014" && error.stage === "auth" && !String(error.message).includes("secret db text"),
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { writeWebResponse } from "./response-adapter.mjs";

function nodeResponse() {
  const headers = new Map();
  return {
    headers,
    statusCode: 0,
    body: null,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    end(value) {
      this.body = value;
    },
  };
}

test("node adapter preserves every Set-Cookie header for secure logout", async () => {
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", "__Host-mi-session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
  headers.append("set-cookie", "mi-session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
  const response = new Response('{"ok":true}', { status: 200, headers });
  const res = nodeResponse();

  await writeWebResponse(res, response);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.headers.get("set-cookie"), headers.getSetCookie());
  assert.equal(res.headers.get("set-cookie").length, 2);
  assert.equal(Buffer.from(res.body).toString("utf8"), '{"ok":true}');
});

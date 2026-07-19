import assert from "node:assert/strict";
import test from "node:test";
import {
  clientSelfConnectEnabled,
  handleAgencyCode
} from "./client-api.mjs";

test("client self-connect is enabled only by the exact true flag", () => {
  assert.equal(clientSelfConnectEnabled({}), false);
  assert.equal(clientSelfConnectEnabled({ MI_CLIENT_SELF_CONNECT_ENABLED: "false" }), false);
  assert.equal(clientSelfConnectEnabled({ MI_CLIENT_SELF_CONNECT_ENABLED: "TRUE" }), false);
  assert.equal(clientSelfConnectEnabled({ MI_CLIENT_SELF_CONNECT_ENABLED: "true" }), true);
});

test("agency-code connect is denied before database access when disabled", async (t) => {
  const previousFlag = process.env.MI_CLIENT_SELF_CONNECT_ENABLED;
  delete process.env.MI_CLIENT_SELF_CONNECT_ENABLED;
  t.after(() => {
    if (previousFlag === undefined) {
      delete process.env.MI_CLIENT_SELF_CONNECT_ENABLED;
    } else {
      process.env.MI_CLIENT_SELF_CONNECT_ENABLED = previousFlag;
    }
  });

  let databaseTouched = false;
  const ctx = {
    userClaims: {
      sub: "00000000-0000-0000-0000-000000000001",
      email: "client@example.com"
    },
    supabaseAdmin: new Proxy({}, {
      get() {
        databaseTouched = true;
        throw new Error("database must not be accessed while self-connect is disabled");
      }
    })
  };
  const request = new Request("https://example.com/api/client/agency-code/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agencyCode: "mml93-a02" })
  });

  const response = await handleAgencyCode(request, ctx);

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "CLIENT_SELF_CONNECT_DISABLED",
    message: "광고주 셀프 연결 기능이 비활성화되어 있습니다. 운영팀에 연결을 요청해주세요."
  });
  assert.equal(databaseTouched, false);
});

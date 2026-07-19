import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAuditMetadata } from "./audit-security.mjs";

test("audit metadata removes credential fields and redacts codes in text", () => {
  const sanitized = sanitizeAuditMetadata({
    source: "report-center",
    teamCode: "mml93-t01",
    agency_code: "mml93-a02",
    nested: {
      authorization: "Bearer secret",
      note: "issued by mml93-t01 for mml93-a02",
      url: "https://example.com/?token=abc123&view=1",
    },
  });

  assert.deepEqual(sanitized, {
    source: "report-center",
    nested: {
      note: "issued by [redacted-code] for [redacted-code]",
      url: "https://example.com/?token=[redacted]&view=1",
    },
  });
});

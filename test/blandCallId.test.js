const test = require("node:test");
const assert = require("node:assert/strict");
const { blandCallUrl, normalizeBlandCallId } = require("../lib/blandCallId");

test("accepts provider call IDs with a strict character allowlist", () => {
  assert.equal(normalizeBlandCallId("call_ABC-123"), "call_ABC-123");
  assert.equal(blandCallUrl("call_ABC-123"), "https://us.api.bland.ai/v1/calls/call_ABC-123");
});

test("rejects path traversal, URLs, and oversized IDs", () => {
  for (const value of ["../admin", "https://evil.test", "a/b", "a".repeat(129), "", null]) {
    assert.equal(normalizeBlandCallId(value), null);
    assert.equal(blandCallUrl(value), null);
  }
});

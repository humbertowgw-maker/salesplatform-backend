const test = require("node:test");
const assert = require("node:assert/strict");
const { selectTenantContext } = require("../lib/tenantContext");

test("uses the verified member organization when no override is requested", () => {
  assert.deepEqual(selectTenantContext({ org_id: "org-a", role: "admin" }), {
    orgId: "org-a", role: "admin", isSuperAdmin: false,
  });
});

test("rejects a cross-tenant override from a normal member", () => {
  assert.deepEqual(selectTenantContext({ org_id: "org-a", role: "admin" }, "org-b"), {
    error: "ORG_ACCESS_DENIED",
  });
});

test("allows an explicit cross-tenant context only for a super admin", () => {
  assert.deepEqual(selectTenantContext({ org_id: "org-a", role: "super_admin" }, "org-b"), {
    orgId: "org-b", role: "super_admin", isSuperAdmin: true,
  });
});

test("rejects authenticated users without membership", () => {
  assert.deepEqual(selectTenantContext(null, "org-b"), { error: "NO_MEMBERSHIP" });
});

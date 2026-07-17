function selectTenantContext(userRole, requestedOrgId) {
  if (!userRole?.org_id) return { error: "NO_MEMBERSHIP" };
  const isSuperAdmin = userRole.role === "super_admin";
  if (requestedOrgId && requestedOrgId !== userRole.org_id && !isSuperAdmin) {
    return { error: "ORG_ACCESS_DENIED" };
  }
  return {
    orgId: requestedOrgId && isSuperAdmin ? requestedOrgId : userRole.org_id,
    role: userRole.role || "rep",
    isSuperAdmin,
  };
}

module.exports = { selectTenantContext };

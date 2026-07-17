const supabase = require("../db/supabase");
const { selectTenantContext } = require("../lib/tenantContext");

async function orgMiddleware(req, res, next) {
  try {
    const requestedOrgId = req.headers["x-org-id"];
    const userEmail = req.verifiedEmail;

    // Public routes must never gain tenant context from caller-controlled headers.
    if (!userEmail) return next();

    let query = supabase.from("user_roles").select("org_id, role, email");
    query = req.verifiedUserId
      ? query.eq("user_id", req.verifiedUserId)
      : query.eq("email", userEmail);
    const { data: userRole, error } = await query.maybeSingle();
    if (error) throw error;
    const context = selectTenantContext(userRole, requestedOrgId);
    if (context.error === "NO_MEMBERSHIP") {
      return res.status(403).json({ error: "No organization membership" });
    }
    if (context.error === "ORG_ACCESS_DENIED") {
      return res.status(403).json({ error: "Organization access denied" });
    }

    req.orgId = context.orgId;
    req.role = context.role;
    req.isSuperAdmin = context.isSuperAdmin;
    req.userEmail = userEmail;
    next();
  } catch (e) {
    console.warn("Org middleware error:", e.message);
    req.orgId = null;
    next();
  }
}

module.exports = orgMiddleware;

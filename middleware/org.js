const supabase = require("../db/supabase");

async function orgMiddleware(req, res, next) {
  try {
    const orgId     = req.headers["x-org-id"];
    const userEmail = req.headers["x-user-email"];
    if (orgId) { req.orgId = orgId; return next(); }
    if (userEmail) {
      const { data: userRole } = await supabase
        .from("user_roles").select("org_id, role").eq("email", userEmail).maybeSingle();
      req.orgId        = userRole?.org_id || null;
      req.role         = userRole?.role || "rep";
      req.isSuperAdmin = userRole?.role === "super_admin";
    }
    next();
  } catch (e) {
    console.warn("Org middleware error:", e.message);
    req.orgId = null;
    next();
  }
}

module.exports = orgMiddleware;

const supabase = require("../db/supabase");

async function orgMiddleware(req, res, next) {
  try {
    const orgId = req.headers["x-org-id"];
    // Prefer JWT-verified email (set by auth middleware) over spoofable header
    const userEmail = req.verifiedEmail || req.headers["x-user-email"];

    if (orgId && !userEmail) { req.orgId = orgId; return next(); }
    if (userEmail) {
      const { data: userRole } = await supabase
        .from("user_roles").select("org_id, role").eq("email", userEmail).maybeSingle();
      req.orgId        = orgId || userRole?.org_id || null;
      req.role         = userRole?.role || "rep";
      req.isSuperAdmin = userRole?.role === "super_admin";
      req.userEmail    = userEmail;
    }
    next();
  } catch (e) {
    console.warn("Org middleware error:", e.message);
    req.orgId = null;
    next();
  }
}

module.exports = orgMiddleware;

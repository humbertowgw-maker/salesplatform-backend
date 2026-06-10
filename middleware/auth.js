// middleware/auth.js — Supabase JWT verification
// Verifies Authorization: Bearer <token> and sets req.verifiedEmail / req.verifiedUserId
// Non-blocking: missing or invalid JWT falls through (existing header-based auth still works)
const supabase = require("../db/supabase");

async function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (!error && user?.email) {
        req.verifiedEmail  = user.email;
        req.verifiedUserId = user.id;
      }
    } catch (e) {
      // Invalid token — ignore, fall through to header-based auth
    }
  }
  next();
}

// Strong guard: requires verified JWT (use on sensitive admin routes)
function requireAuth(req, res, next) {
  if (!req.verifiedEmail) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

// Role guard: requires admin or super_admin
function requireAdmin(req, res, next) {
  if (!["admin", "super_admin"].includes(req.role)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

module.exports = { authMiddleware, requireAuth, requireAdmin };

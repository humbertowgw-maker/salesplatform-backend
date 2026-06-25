// middleware/trialGuard.js — blocks API access for expired or cancelled orgs
// Must run after authMiddleware + orgMiddleware (needs req.orgId, req.isSuperAdmin)
// Skip list keeps billing and org-creation reachable so users can upgrade / sign up.
const supabase = require("../db/supabase");

// Simple in-memory cache: orgId → { status, trialEndsAt, fetchedAt }
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 1 minute

async function getOrgStatus(orgId) {
  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const { data } = await supabase
    .from("organizations")
    .select("plan_status, trial_ends_at")
    .eq("id", orgId)
    .maybeSingle();

  const entry = {
    status:       data?.plan_status  || null,
    trialEndsAt:  data?.trial_ends_at || null,
    fetchedAt:    Date.now(),
  };
  cache.set(orgId, entry);
  return entry;
}

const SKIP_PREFIXES = [
  "/billing",            // must stay open so expired orgs can upgrade
  "/organizations",      // org creation (self-signup) + brand/presets
  "/webhooks",           // inbound webhooks don't carry org auth
  "/texts/inbound",      // Twilio inbound SMS
];

async function trialGuard(req, res, next) {
  // Super admin bypasses; unauthenticated or org-less requests bypass
  if (req.isSuperAdmin || !req.orgId) return next();

  // Skip billing + signup paths so expired users can still pay/sign up
  if (SKIP_PREFIXES.some(p => req.path === p || req.path.startsWith(p + "/"))) return next();

  try {
    const org = await getOrgStatus(req.orgId);

    if (org.status === "trial" && org.trialEndsAt && new Date(org.trialEndsAt) < new Date()) {
      return res.status(402).json({ error: "Trial expired. Upgrade to continue.", code: "TRIAL_EXPIRED" });
    }
    if (org.status === "cancelled") {
      return res.status(402).json({ error: "Account suspended. Contact support to reactivate.", code: "ACCOUNT_SUSPENDED" });
    }
    next();
  } catch (e) {
    // Don't block on a guard failure — log and let the route handle auth
    console.warn("[trialGuard]", e.message);
    next();
  }
}

module.exports = trialGuard;

// routes/public.js — unauthenticated endpoints for self-serve customer flows
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");
const { getPreset } = require("../lib/industryPresets");

// POST /api/public/signup — atomic signup: creates Supabase auth user + org + super_admin role
// No JWT required. Uses service-role admin API to auto-confirm email.
router.post("/signup", async (req, res) => {
  const { org_name, email, password, industry_key = "general_crm" } = req.body;

  if (!org_name?.trim() || !email?.trim() || !password?.trim()) {
    return res.status(400).json({ error: "org_name, email, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  try {
    // 1. Create Supabase auth user with auto-confirmed email
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authErr) {
      // Friendly error for duplicate email
      if (authErr.message?.toLowerCase().includes("already")) {
        return res.status(409).json({ error: "An account with this email already exists. Please sign in." });
      }
      return res.status(400).json({ error: authErr.message });
    }

    const userId = authData.user?.id;
    if (!userId) return res.status(500).json({ error: "User creation failed" });

    // 2. Create org with 14-day trial
    const preset = getPreset(industry_key);
    const slug = org_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      + "-" + Math.random().toString(36).slice(2, 6);

    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .insert({
        name:               org_name.trim(),
        slug,
        owner_email:        email,
        plan:               "trial",
        plan_status:        "trial",
        trial_ends_at:      new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        industry_key:       preset.key,
        enabled_modules:    preset.modules,
        custom_wording:     preset.wording,
        pipeline_stages:    preset.pipelineStages,
        research_tools:     preset.researchTools,
        onboarding_complete: false,
      })
      .select()
      .single();

    if (orgErr) throw new Error(orgErr.message);

    // 3. Assign user as super_admin of the new org
    const { error: roleErr } = await supabase
      .from("user_roles")
      .insert({ user_id: userId, email, role: "super_admin", org_id: org.id });

    if (roleErr) throw new Error(roleErr.message);

    console.log(`[signup] New org: ${org.name} (${org.id}) — user: ${email}`);

    res.json({ success: true, org_id: org.id, org_name: org.name });
  } catch (e) {
    console.error("[signup] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

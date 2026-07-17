// routes/organizations.js — org management for SaaS
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");
const { PRESETS, getPreset, buildConfig } = require("../lib/industryPresets");

async function requireOrgAdmin(req, res) {
  const orgId = req.orgId;
  const email = req.userEmail;
  if (!orgId || !email) {
    res.status(401).json({ error: "Missing org/user context" });
    return null;
  }

  const { data: role } = await supabase
    .from("user_roles").select("role").eq("email", email).eq("org_id", orgId).maybeSingle();
  if (!["admin","super_admin"].includes(role?.role)) {
    res.status(403).json({ error: "Admin only" });
    return null;
  }

  return { orgId, email, role: role.role };
}

// GET /api/organizations/me — get current org
router.get("/me", async (req, res) => {
  const email = req.userEmail;
  if (!email) return res.status(401).json({ error: "No user email" });

  try {
    const { data: userRole } = await supabase
      .from("user_roles")
      .select("org_id, role")
      .eq("email", email)
      .maybeSingle();

    if (!userRole?.org_id) return res.status(404).json({ error: "No organization found" });

    const { data: org } = await supabase
      .from("organizations")
      .select("*")
      .eq("id", userRole.org_id)
      .single();

    res.json({ org, role: userRole.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/organizations — create new org (dealer signup)
router.post("/", async (req, res) => {
  const { name, dealer_code, industry_key = "general_crm" } = req.body;
  const owner_email = req.userEmail;
  const user_id = req.verifiedUserId;
  if (!name || !owner_email) return res.status(400).json({ error: "name and owner_email required" });

  try {
    const preset = getPreset(industry_key);
    // Create slug from name
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") 
      + "-" + Math.random().toString(36).slice(2, 6);

    const { data: org, error } = await supabase
      .from("organizations")
      .insert({
        name,
        slug,
        owner_email,
        dealer_code,
        plan: "trial",
        plan_status: "trial",
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        industry_key: preset.key,
        enabled_modules: preset.modules,
        custom_wording: preset.wording,
        pipeline_stages: preset.pipelineStages,
        research_tools: preset.researchTools,
        onboarding_complete: false,
      })
      .select()
      .single();

    if (error) throw error;

    // Assign user to org as admin
    if (user_id) {
      const { error: roleErr } = await supabase.from("user_roles").upsert({
        user_id, email: owner_email, role: "admin", org_id: org.id,
      }, { onConflict: "user_id" });
      if (roleErr) throw roleErr;
    }

    res.json({ org });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/organizations/all — super admin only
router.get("/all", async (req, res) => {
  try {
    if (!req.isSuperAdmin) return res.status(403).json({ error: "Super admin only" });

    const { data: orgs } = await supabase
      .from("organizations")
      .select("*, user_roles(count)")
      .order("created_at", { ascending: false });

    res.json(orgs || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/organizations/presets — available app-factory industry presets
router.get("/presets", async (req, res) => {
  res.json({ presets: Object.values(PRESETS) });
});

// GET /api/organizations/brand — returns org brand config (no auth, uses x-org-id header)
router.get("/brand", async (req, res) => {
  const orgId = req.headers["x-org-id"];
  if (!orgId) return res.json({ brand_name: null, ai_name: null, tagline: null, logo_url: null, primary_color: null });
  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("brand_name, ai_name, tagline, logo_url, primary_color, name")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw error;
    res.json(data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/organizations/brand — update org brand (admin only)
router.patch("/brand", async (req, res) => {
  const ctx = await requireOrgAdmin(req, res);
  if (!ctx) return;

  const { brand_name, ai_name, tagline, logo_url, primary_color } = req.body;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .update({ brand_name, ai_name, tagline, logo_url, primary_color, updated_at: new Date() })
      .eq("id", ctx.orgId)
      .select("brand_name, ai_name, tagline, logo_url, primary_color, name")
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/organizations/config — current tenant app-factory config
router.get("/config", async (req, res) => {
  const orgId = req.orgId;
  if (!orgId) return res.json(buildConfig());

  try {
    const { data, error } = await supabase
      .from("organizations")
      .select("industry_key, enabled_modules, custom_wording, pipeline_stages, research_tools")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw error;
    res.json(buildConfig(data || {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/organizations/config — update current tenant app-factory config
router.patch("/config", async (req, res) => {
  const ctx = await requireOrgAdmin(req, res);
  if (!ctx) return;

  const currentPreset = getPreset(req.body.industry_key);
  const updates = {
    industry_key: currentPreset.key,
    enabled_modules: Array.isArray(req.body.enabled_modules) ? req.body.enabled_modules : currentPreset.modules,
    custom_wording: req.body.custom_wording && typeof req.body.custom_wording === "object" ? req.body.custom_wording : currentPreset.wording,
    pipeline_stages: Array.isArray(req.body.pipeline_stages) ? req.body.pipeline_stages : currentPreset.pipelineStages,
    research_tools: Array.isArray(req.body.research_tools) ? req.body.research_tools : currentPreset.researchTools,
    updated_at: new Date(),
  };

  try {
    const { data, error } = await supabase
      .from("organizations")
      .update(updates)
      .eq("id", ctx.orgId)
      .select("industry_key, enabled_modules, custom_wording, pipeline_stages, research_tools")
      .single();
    if (error) throw error;
    res.json(buildConfig(data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/organizations/apply-preset — reset config to a preset
router.post("/apply-preset", async (req, res) => {
  const ctx = await requireOrgAdmin(req, res);
  if (!ctx) return;

  const preset = getPreset(req.body.industry_key);
  try {
    const { data, error } = await supabase
      .from("organizations")
      .update({
        industry_key: preset.key,
        enabled_modules: preset.modules,
        custom_wording: preset.wording,
        pipeline_stages: preset.pipelineStages,
        research_tools: preset.researchTools,
        updated_at: new Date(),
      })
      .eq("id", ctx.orgId)
      .select("industry_key, enabled_modules, custom_wording, pipeline_stages, research_tools")
      .single();
    if (error) throw error;
    res.json(buildConfig(data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/organizations/me/onboarding-complete — mark onboarding done
router.post("/me/onboarding-complete", async (req, res) => {
  const orgId = req.orgId;
  if (!orgId) return res.status(401).json({ error: "No org context" });
  try {
    await supabase.from("organizations").update({ onboarding_complete: true }).eq("id", orgId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/organizations/feature-requests — tenant feature request list
router.get("/feature-requests", async (req, res) => {
  if (!req.orgId) return res.status(401).json({ error: "No organization context" });
  try {
    const { data, error } = await supabase
      .from("feature_requests")
      .select("*")
      .eq("org_id", req.orgId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ requests: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/organizations/feature-requests — submit tenant feature request
router.post("/feature-requests", async (req, res) => {
  if (!req.orgId) return res.status(401).json({ error: "No organization context" });
  const { title, description, module, priority = "normal" } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });

  try {
    const { data, error } = await supabase
      .from("feature_requests")
      .insert({
        org_id: req.orgId,
        requested_by: req.userEmail || null,
        title,
        description,
        module,
        priority,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/organizations/:id — update org settings
router.patch("/:id", async (req, res) => {
  const ctx = await requireOrgAdmin(req, res);
  if (!ctx) return;
  if (ctx.orgId !== req.params.id) return res.status(403).json({ error: "Cannot modify another organization" });
  const { name, dealer_code, logo_url, primary_color } = req.body;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .update({ name, dealer_code, logo_url, primary_color, updated_at: new Date() })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// routes/organizations.js — org management for SaaS
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

// GET /api/organizations/me — get current org
router.get("/me", async (req, res) => {
  const email = req.headers["x-user-email"];
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
  const { name, owner_email, dealer_code, user_id } = req.body;
  if (!name || !owner_email) return res.status(400).json({ error: "name and owner_email required" });

  try {
    // Create slug from name
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") 
      + "-" + Math.random().toString(36).slice(2, 6);

    const { data: org, error } = await supabase
      .from("organizations")
      .insert({ name, slug, owner_email, dealer_code, plan: "trial", plan_status: "trial" })
      .select()
      .single();

    if (error) throw error;

    // Assign user to org as admin
    if (user_id) {
      await supabase.from("user_roles").upsert({
        user_id, email: owner_email, role: "admin", org_id: org.id,
      }, { onConflict: "user_id" });
    }

    res.json({ org });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/organizations/:id — update org settings
router.patch("/:id", async (req, res) => {
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

// GET /api/organizations/all — super admin only
router.get("/all", async (req, res) => {
  const email = req.headers["x-user-email"];
  try {
    const { data: userRole } = await supabase.from("user_roles").select("role").eq("email", email).maybeSingle();
    if (userRole?.role !== "super_admin") return res.status(403).json({ error: "Super admin only" });

    const { data: orgs } = await supabase
      .from("organizations")
      .select("*, user_roles(count)")
      .order("created_at", { ascending: false });

    res.json(orgs || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  const orgId = req.headers["x-org-id"];
  const email = req.headers["x-user-email"];
  if (!orgId || !email) return res.status(401).json({ error: "Missing org/user context" });

  // Verify admin role
  const { data: role } = await supabase
    .from("user_roles").select("role").eq("email", email).eq("org_id", orgId).maybeSingle();
  if (!["admin","super_admin"].includes(role?.role)) return res.status(403).json({ error: "Admin only" });

  const { brand_name, ai_name, tagline, logo_url, primary_color } = req.body;
  try {
    const { data, error } = await supabase
      .from("organizations")
      .update({ brand_name, ai_name, tagline, logo_url, primary_color, updated_at: new Date() })
      .eq("id", orgId)
      .select("brand_name, ai_name, tagline, logo_url, primary_color, name")
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

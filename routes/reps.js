// routes/reps.js — Rep management
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

// GET /api/reps
router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("rep_dashboard")   // uses the view from schema.sql
      .select("*");
    if (error) throw error;
    res.json({ reps: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reps/:id/calendar — rep's full appointment calendar
router.get("/:id/calendar", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("rep_id", req.params.id)
      .not("status", "in", '("Cancelled","No Show")')
      .order("scheduled_day");
    if (error) throw error;
    res.json({ appointments: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reps — create a rep
router.post("/", async (req, res) => {
  const { name, email, phone, color } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const { data, error } = await supabase
      .from("reps")
      .insert({ name, email, phone, color: color || "#f97316" })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/reps/:id
router.patch("/:id", async (req, res) => {
  const { name, email, phone, color, active } = req.body;
  try {
    const { data, error } = await supabase
      .from("reps")
      .update({ name, email, phone, color, active })
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reps/invite — invite a rep via magic-link email (admin only)
router.post("/invite", async (req, res) => {
  const { email, name, redirectTo } = req.body;
  const orgId = req.headers["x-org-id"] || req.body.org_id;
  if (!email) return res.status(400).json({ error: "email is required" });
  if (!orgId) return res.status(400).json({ error: "org context required" });
  try {
    // 1) Send the magic-link invite (admin op — needs the service key)
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(
      email,
      redirectTo ? { redirectTo } : undefined
    );
    if (error) throw error;

    // 2) Record the role so the user shows up in User Management
    const userId = data?.user?.id;
    if (userId) {
      const { error: roleErr } = await supabase
        .from("user_roles")
        .insert({ user_id: userId, email, role: "rep", org_id: orgId });
      if (roleErr) throw roleErr;
    }

    res.status(201).json({ invited: true, user: data?.user || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reps/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase.from("reps").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

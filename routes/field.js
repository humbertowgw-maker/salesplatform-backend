// routes/field.js — rep field check-ins with geolocation
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

// POST /api/field/checkin — log a check-in
router.post("/checkin", async (req, res) => {
  const { lat, lng, address, note, rep_id } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: "lat and lng required" });

  try {
    const { data, error } = await supabase
      .from("field_checkins")
      .insert({
        org_id:  req.orgId,
        rep_id:  rep_id || null,
        lat:     parseFloat(lat),
        lng:     parseFloat(lng),
        address: address || null,
        note:    note || null,
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ checkin: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/field/checkins — list check-ins with optional filters
router.get("/checkins", async (req, res) => {
  const { rep_id, since, date } = req.query;
  if (!req.orgId) return res.status(401).json({ error: "No org context" });

  try {
    let query = supabase
      .from("field_checkins")
      .select("*, reps(name, color)")
      .eq("org_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (rep_id) query = query.eq("rep_id", rep_id);
    if (since)  query = query.gte("created_at", since);
    if (date)   query = query.gte("created_at", date + "T00:00:00").lte("created_at", date + "T23:59:59");

    const { data, error } = await query;
    if (error) throw error;
    res.json({ checkins: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/field/checkins/today — today's check-ins across all reps
router.get("/checkins/today", async (req, res) => {
  if (!req.orgId) return res.status(401).json({ error: "No org context" });

  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await supabase
      .from("field_checkins")
      .select("*, reps(name, color)")
      .eq("org_id", req.orgId)
      .gte("created_at", today + "T00:00:00")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ checkins: data || [], date: today });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/field/checkins/:id
router.delete("/checkins/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("field_checkins")
      .delete()
      .eq("id", req.params.id)
      .eq("org_id", req.orgId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/field/routes — save a planned route for a rep
router.post("/routes", async (req, res) => {
  const { rep_id, name, waypoints, date } = req.body;
  if (!rep_id || !waypoints?.length) return res.status(400).json({ error: "rep_id and waypoints required" });

  try {
    const { data, error } = await supabase
      .from("field_routes")
      .insert({
        org_id:    req.orgId,
        rep_id,
        name:      name || "Route",
        waypoints: waypoints,
        route_date: date || new Date().toISOString().slice(0, 10),
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ route: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/field/routes — list routes for org
router.get("/routes", async (req, res) => {
  const { rep_id } = req.query;
  if (!req.orgId) return res.status(401).json({ error: "No org context" });

  try {
    let query = supabase
      .from("field_routes")
      .select("*, reps(name, color)")
      .eq("org_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (rep_id) query = query.eq("rep_id", rep_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ routes: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/field/routes/:id
router.delete("/routes/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("field_routes")
      .delete()
      .eq("id", req.params.id)
      .eq("org_id", req.orgId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

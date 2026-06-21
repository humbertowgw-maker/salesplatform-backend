// routes/activity.js — org activity / audit log
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

// GET /api/activity — paginated activity feed for the org
router.get("/", async (req, res) => {
  const { limit = 50, offset = 0, lead_id, rep_id, event_type, since } = req.query;
  if (!req.orgId) return res.status(401).json({ error: "No org context" });

  try {
    let query = supabase
      .from("activity_log")
      .select("*")
      .eq("org_id", req.orgId)
      .order("created_at", { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (lead_id)     query = query.eq("lead_id", lead_id);
    if (rep_id)      query = query.eq("rep_id", rep_id);
    if (event_type)  query = query.eq("event_type", event_type);
    if (since)       query = query.gte("created_at", since);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/activity/recent — last 20 events for dashboard
router.get("/recent", async (req, res) => {
  if (!req.orgId) return res.status(401).json({ error: "No org context" });
  try {
    const { data, error } = await supabase
      .from("activity_log")
      .select("*")
      .eq("org_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ events: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/activity — log an event (internal and external)
router.post("/", async (req, res) => {
  const { event_type, description, lead_id, rep_id, metadata } = req.body;
  if (!event_type) return res.status(400).json({ error: "event_type required" });

  try {
    const { data, error } = await supabase
      .from("activity_log")
      .insert({
        org_id:      req.orgId,
        user_email:  req.headers["x-user-email"] || null,
        event_type,
        description: description || null,
        lead_id:     lead_id || null,
        rep_id:      rep_id || null,
        metadata:    metadata || null,
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ event: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exported helper for other routes to log events without HTTP round-trips
async function logActivity({ orgId, userEmail, eventType, description, leadId, repId, metadata }) {
  try {
    await supabase.from("activity_log").insert({
      org_id:      orgId,
      user_email:  userEmail || null,
      event_type:  eventType,
      description: description || null,
      lead_id:     leadId || null,
      rep_id:      repId || null,
      metadata:    metadata || null,
    });
  } catch (e) {
    console.warn("[activity] log error:", e.message);
  }
}

module.exports = router;
module.exports.logActivity = logActivity;

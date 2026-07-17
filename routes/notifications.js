// routes/notifications.js — in-app notification system
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

// GET /api/notifications — list notifications for current user/org
router.get("/", async (req, res) => {
  const email = req.userEmail;
  const orgId = req.orgId;
  if (!email && !orgId) return res.status(401).json({ error: "Not authenticated" });

  try {
    let query = supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (email) query = query.or(`user_email.eq.${email},user_email.is.null`);
    if (orgId) query = query.eq("org_id", orgId);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ notifications: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/notifications/unread-count
router.get("/unread-count", async (req, res) => {
  const email = req.userEmail;
  const orgId = req.orgId;
  if (!email && !orgId) return res.json({ count: 0 });

  try {
    let query = supabase
      .from("notifications")
      .select("id", { count: "exact" })
      .eq("read", false);

    if (orgId) query = query.eq("org_id", orgId);
    if (email) query = query.or(`user_email.eq.${email},user_email.is.null`);

    const { count, error } = await query;
    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/notifications/:id/read — mark single notification as read
router.patch("/:id/read", async (req, res) => {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ read: true })
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/mark-all-read — mark all as read for this user/org
router.post("/mark-all-read", async (req, res) => {
  const email = req.userEmail;
  const orgId = req.orgId;

  try {
    let query = supabase
      .from("notifications")
      .update({ read: true })
      .eq("read", false);

    if (orgId) query = query.eq("org_id", orgId);
    if (email) query = query.or(`user_email.eq.${email},user_email.is.null`);

    const { error } = await query;
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications — create notification (admin/system use)
router.post("/", async (req, res) => {
  if (!["admin", "super_admin"].includes(req.role)) {
    return res.status(403).json({ error: "Admin only" });
  }

  const { title, body, type = "info", link, user_email } = req.body;
  if (!title) return res.status(400).json({ error: "title required" });

  try {
    const { data, error } = await supabase
      .from("notifications")
      .insert({
        org_id:     req.orgId,
        user_email: user_email || null,
        title,
        body:       body || null,
        type,
        link:       link || null,
        read:       false,
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ notification: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/notifications/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exported helper so other routes can create notifications
async function createNotification({ orgId, userEmail, title, body, type = "info", link }) {
  try {
    await supabase.from("notifications").insert({
      org_id:     orgId,
      user_email: userEmail || null,
      title,
      body:       body || null,
      type,
      link:       link || null,
      read:       false,
    });
  } catch (e) {
    console.warn("[notifications] create error:", e.message);
  }
}

module.exports = router;
module.exports.createNotification = createNotification;

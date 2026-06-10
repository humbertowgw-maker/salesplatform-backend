// routes/director.js — Artificial Director API
// Admin-only: briefings, tasks, approval queue, rep stats, workload balance.
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");
const director = require("../lib/director");
const telegram = require("../lib/telegram");

// Role guard — all director routes require admin or super_admin
router.use((req, res, next) => {
  if (!["admin", "super_admin"].includes(req.role)) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
});

// ── BRIEFINGS ──────────────────────────────────────────────────────────────────

// GET /api/director/briefing?date=YYYY-MM-DD&rep_id=uuid
// Returns today's org-wide briefing (or rep-specific if rep_id given)
router.get("/briefing", async (req, res) => {
  const date   = req.query.date   || new Date().toISOString().slice(0, 10);
  const rep_id = req.query.rep_id || null;
  try {
    let query = supabase
      .from("director_briefings")
      .select("*")
      .eq("briefing_date", date)
      .eq("type", "daily");

    if (rep_id) {
      query = query.eq("rep_id", rep_id);
    } else {
      query = query.is("rep_id", null);
      if (req.orgId) query = query.eq("org_id", req.orgId);
    }

    const { data } = await query.maybeSingle();
    res.json(data || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/director/briefing/all-reps?date=YYYY-MM-DD
// Returns per-rep briefings for a date (for director dashboard)
router.get("/briefing/all-reps", async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    let query = supabase
      .from("director_briefings")
      .select("*, reps(name, color)")
      .eq("briefing_date", date)
      .eq("type", "daily")
      .not("rep_id", "is", null);
    if (req.orgId) query = query.eq("org_id", req.orgId);
    const { data } = await query.order("created_at");
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/director/briefing/generate
// Triggers AI briefing generation for today
router.post("/briefing/generate", async (req, res) => {
  try {
    const content = await director.buildDailyBriefing(req.orgId);
    res.json({ ok: true, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TASKS ──────────────────────────────────────────────────────────────────────

// GET /api/director/tasks?rep_id=&status=open
router.get("/tasks", async (req, res) => {
  const { rep_id, status = "open" } = req.query;
  try {
    let query = supabase
      .from("rep_tasks")
      .select("*, reps(name, color)")
      .order("due_date", { ascending: true })
      .order("priority", { ascending: false });

    if (rep_id) query = query.eq("rep_id", rep_id);
    else if (req.orgId) query = query.eq("org_id", req.orgId);

    if (status !== "all") query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/director/tasks
router.post("/tasks", async (req, res) => {
  const { rep_id, title, description, due_date, priority } = req.body;
  if (!rep_id || !title) return res.status(400).json({ error: "rep_id and title required" });
  try {
    const { data, error } = await supabase.from("rep_tasks").insert({
      rep_id, org_id: req.orgId, title, description, due_date,
      priority: priority || "normal",
      assigned_by: req.userEmail || "admin",
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/director/tasks/:id
router.patch("/tasks/:id", async (req, res) => {
  const { status, title, description, due_date, priority } = req.body;
  const updates = {};
  if (status)      { updates.status = status; if (status === "done") updates.completed_at = new Date().toISOString(); }
  if (title)       updates.title       = title;
  if (description) updates.description = description;
  if (due_date)    updates.due_date    = due_date;
  if (priority)    updates.priority    = priority;
  try {
    const { data, error } = await supabase.from("rep_tasks").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/director/tasks/:id
router.delete("/tasks/:id", async (req, res) => {
  try {
    await supabase.from("rep_tasks").delete().eq("id", req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── APPROVAL QUEUE ────────────────────────────────────────────────────────────

// GET /api/director/actions?status=pending
router.get("/actions", async (req, res) => {
  const { status = "pending" } = req.query;
  try {
    let query = supabase
      .from("director_actions")
      .select("*")
      .order("created_at", { ascending: false });
    if (req.orgId) query = query.eq("org_id", req.orgId);
    if (status !== "all") query = query.eq("status", status);
    const { data } = await query;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/director/actions/:id/approve
router.post("/actions/:id/approve", async (req, res) => {
  const approver = req.userEmail || req.headers["x-user-email"];
  try {
    const { data: action } = await supabase
      .from("director_actions").select("*").eq("id", req.params.id).single();
    if (!action) return res.status(404).json({ error: "Action not found" });
    if (action.status !== "pending") return res.status(400).json({ error: "Action is not pending" });

    await supabase.from("director_actions").update({
      status:      "approved",
      approved_by: approver,
      approved_at: new Date().toISOString(),
    }).eq("id", req.params.id);

    // Execute the action if it's a workload rebalance
    if (action.action_type === "workload_rebalance" && action.payload?.overloaded?.length) {
      // Approved — mark as executed; admin handles manual reassignment from the UI
      await supabase.from("director_actions")
        .update({ status: "executed" }).eq("id", req.params.id);
    }

    await telegram.sendMessage(
      `✅ <b>Director Action Approved</b>\n\n` +
      `<b>Type:</b> ${action.action_type}\n` +
      `<b>Rep:</b> ${action.target_rep_name || "—"}\n` +
      `<b>Approved by:</b> ${approver}`
    );

    res.json({ ok: true, approved_by: approver });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/director/actions/:id/reject
router.post("/actions/:id/reject", async (req, res) => {
  const { reason } = req.body;
  const approver = req.userEmail || req.headers["x-user-email"];
  try {
    const { data: action } = await supabase
      .from("director_actions").select("*").eq("id", req.params.id).single();
    if (!action) return res.status(404).json({ error: "Action not found" });

    await supabase.from("director_actions").update({
      status:           "rejected",
      approved_by:      approver,
      approved_at:      new Date().toISOString(),
      rejection_reason: reason || "No reason provided",
    }).eq("id", req.params.id);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── REP STATS ─────────────────────────────────────────────────────────────────

// GET /api/director/rep-stats?days=7
// Returns KPI snapshot for all reps (director dashboard view)
router.get("/rep-stats", async (req, res) => {
  const days = parseInt(req.query.days || "7");
  try {
    const { data: reps } = await supabase
      .from("reps").select("id, name, color, title, territory, employment_status").eq("active", true);

    if (!reps?.length) return res.json([]);

    const stats = await Promise.all(
      reps.map(async r => ({
        rep: r,
        stats: await director.getRepStats(r.id, days),
      }))
    );

    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GOALS ─────────────────────────────────────────────────────────────────────

// GET /api/director/goals?rep_id=
router.get("/goals", async (req, res) => {
  const ws = req.query.week_start || new Date().toISOString().slice(0, 10);
  try {
    let query = supabase.from("rep_goals").select("*, reps(name)");
    if (req.query.rep_id) query = query.eq("rep_id", req.query.rep_id);
    else if (req.orgId)   query = query.eq("org_id", req.orgId);
    const { data } = await query;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/director/goals
router.post("/goals", async (req, res) => {
  const { rep_id, week_start, calls_target, appts_target } = req.body;
  if (!rep_id) return res.status(400).json({ error: "rep_id required" });
  const ws = week_start || new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await supabase.from("rep_goals").upsert({
      rep_id, org_id: req.orgId, week_start: ws,
      calls_target: calls_target || 30,
      appts_target: appts_target || 5,
      created_by: req.userEmail || "admin",
    }, { onConflict: "rep_id,week_start" }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTOMATION TRIGGERS ───────────────────────────────────────────────────────

// POST /api/director/run-assessment
router.post("/run-assessment", async (req, res) => {
  try {
    const result = await director.runPerformanceAssessment(req.orgId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/director/run-tasks
router.post("/run-tasks", async (req, res) => {
  try {
    const result = await director.autoAssignTasks(req.orgId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/director/check-balance
router.post("/check-balance", async (req, res) => {
  try {
    const result = await director.checkWorkloadBalance(req.orgId);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

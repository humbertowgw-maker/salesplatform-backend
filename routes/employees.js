// routes/employees.js — team performance, KPIs, leaderboard, goals
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

function since(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function weekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff); d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

// GET /api/employees — all reps with aggregated KPIs
router.get("/", async (req, res) => {
  if (!req.orgId) return res.status(401).json({ error: "No org context" });

  const days = parseInt(req.query.days || "30");
  const since30 = since(days);
  const since7  = since(7);
  const ws = weekStart();

  try {
    const [repsRes, callsRes, apptsRes, leadsRes, goalsRes] = await Promise.allSettled([
      supabase.from("reps").select("*").eq("org_id", req.orgId).eq("active", true),
      supabase.from("call_logs").select("rep_id,outcome,status,duration_seconds,created_at").eq("org_id", req.orgId).gte("created_at", since30),
      supabase.from("appointments").select("rep_id,status,created_at").eq("org_id", req.orgId).gte("created_at", since30),
      supabase.from("leads").select("rep_id,status").eq("org_id", req.orgId),
      supabase.from("rep_goals").select("*").eq("org_id", req.orgId).eq("week_start", ws),
    ]);

    const reps  = repsRes.status  === "fulfilled" ? repsRes.value.data  || [] : [];
    const calls = callsRes.status === "fulfilled" ? callsRes.value.data || [] : [];
    const appts = apptsRes.status === "fulfilled" ? apptsRes.value.data || [] : [];
    const leads = leadsRes.status === "fulfilled" ? leadsRes.value.data || [] : [];
    const goals = goalsRes.status === "fulfilled" ? goalsRes.value.data || [] : [];

    const employees = reps.map(rep => {
      const rCalls = calls.filter(c => c.rep_id === rep.id);
      const rAppts = appts.filter(a => a.rep_id === rep.id);
      const rLeads = leads.filter(l => l.rep_id === rep.id);
      const rGoal  = goals.find(g => g.rep_id === rep.id) || {};

      const totalCalls     = rCalls.length;
      const answeredCalls  = rCalls.filter(c => (c.duration_seconds || 0) > 20).length;
      const bookedAppts    = rAppts.filter(a => a.status !== "Cancelled").length;
      const completedAppts = rAppts.filter(a => a.status === "Completed").length;
      const converted      = rLeads.filter(l => l.status === "Converted").length;
      const avgDuration    = totalCalls
        ? Math.round(rCalls.reduce((s, c) => s + (c.duration_seconds || 0), 0) / totalCalls)
        : 0;

      const callsThisWeek = rCalls.filter(c => c.created_at >= since7).length;
      const apptsThisWeek = rAppts.filter(a => a.created_at >= since7).length;

      return {
        ...rep,
        kpis: {
          totalCalls,
          answeredCalls,
          answerRate:    totalCalls ? Math.round((answeredCalls / totalCalls) * 100) : 0,
          bookedAppts,
          completedAppts,
          bookingRate:   answeredCalls ? Math.round((bookedAppts / answeredCalls) * 100) : 0,
          converted,
          conversionRate: rLeads.length ? Math.round((converted / rLeads.length) * 100) : 0,
          totalLeads:    rLeads.length,
          avgCallDuration: avgDuration,
          callsThisWeek,
          apptsThisWeek,
        },
        goals: {
          calls_target: rGoal.calls_target || 0,
          appts_target: rGoal.appts_target || 0,
          revenue_target: rGoal.revenue_target || 0,
        },
      };
    });

    res.json({ employees });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employees/leaderboard — top performers ranked by bookings
router.get("/leaderboard", async (req, res) => {
  if (!req.orgId) return res.status(401).json({ error: "No org context" });

  const since30 = since(30);

  try {
    const [repsRes, callsRes, apptsRes, leadsRes] = await Promise.allSettled([
      supabase.from("reps").select("id,name,color").eq("org_id", req.orgId).eq("active", true),
      supabase.from("call_logs").select("rep_id,outcome").eq("org_id", req.orgId).gte("created_at", since30),
      supabase.from("appointments").select("rep_id,status").eq("org_id", req.orgId).gte("created_at", since30),
      supabase.from("leads").select("rep_id,status").eq("org_id", req.orgId),
    ]);

    const reps  = repsRes.status  === "fulfilled" ? repsRes.value.data  || [] : [];
    const calls = callsRes.status === "fulfilled" ? callsRes.value.data || [] : [];
    const appts = apptsRes.status === "fulfilled" ? apptsRes.value.data || [] : [];
    const leads = leadsRes.status === "fulfilled" ? leadsRes.value.data || [] : [];

    const board = reps.map(rep => ({
      ...rep,
      calls:     calls.filter(c => c.rep_id === rep.id).length,
      booked:    appts.filter(a => a.rep_id === rep.id && a.status !== "Cancelled").length,
      converted: leads.filter(l => l.rep_id === rep.id && l.status === "Converted").length,
      score:     (appts.filter(a => a.rep_id === rep.id && a.status !== "Cancelled").length * 3)
               + (leads.filter(l => l.rep_id === rep.id && l.status === "Converted").length * 5)
               + (calls.filter(c => c.rep_id === rep.id).length),
    })).sort((a, b) => b.score - a.score).map((rep, i) => ({ ...rep, rank: i + 1 }));

    res.json({ leaderboard: board });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employees/:id/stats — detailed stats for one rep
router.get("/:id/stats", async (req, res) => {
  const repId = req.params.id;
  const days  = parseInt(req.query.days || "30");
  const since30 = since(days);

  try {
    const [repRes, callsRes, apptsRes, leadsRes] = await Promise.allSettled([
      supabase.from("reps").select("*").eq("id", repId).single(),
      supabase.from("call_logs").select("*").eq("rep_id", repId).gte("created_at", since30).order("created_at", { ascending: false }),
      supabase.from("appointments").select("*").eq("rep_id", repId).gte("created_at", since30).order("created_at", { ascending: false }),
      supabase.from("leads").select("id,status,business_name,city").eq("rep_id", repId),
    ]);

    const rep   = repRes.status   === "fulfilled" ? repRes.value.data   : null;
    const calls = callsRes.status === "fulfilled" ? callsRes.value.data || [] : [];
    const appts = apptsRes.status === "fulfilled" ? apptsRes.value.data || [] : [];
    const leads = leadsRes.status === "fulfilled" ? leadsRes.value.data || [] : [];

    if (!rep) return res.status(404).json({ error: "Rep not found" });

    // Daily activity for sparkline (last 14 days)
    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const ds = d.toISOString().slice(0, 10);
      daily.push({
        date:  ds,
        calls: calls.filter(c => c.created_at?.slice(0, 10) === ds).length,
        appts: appts.filter(a => a.created_at?.slice(0, 10) === ds).length,
      });
    }

    res.json({
      rep,
      calls:  calls.slice(0, 20),
      appts:  appts.slice(0, 20),
      leads,
      daily,
      summary: {
        totalCalls:     calls.length,
        answeredCalls:  calls.filter(c => (c.duration_seconds || 0) > 20).length,
        bookedAppts:    appts.filter(a => a.status !== "Cancelled").length,
        completedAppts: appts.filter(a => a.status === "Completed").length,
        converted:      leads.filter(l => l.status === "Converted").length,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/employees/:id/goal — set weekly goal for a rep
router.post("/:id/goal", async (req, res) => {
  if (!["admin", "super_admin"].includes(req.role)) {
    return res.status(403).json({ error: "Admin only" });
  }

  const { calls_target, appts_target, revenue_target } = req.body;
  const ws = weekStart();

  try {
    const { data, error } = await supabase
      .from("rep_goals")
      .upsert({
        org_id:         req.orgId,
        rep_id:         req.params.id,
        week_start:     ws,
        calls_target:   calls_target || 0,
        appts_target:   appts_target || 0,
        revenue_target: revenue_target || 0,
      }, { onConflict: "org_id,rep_id,week_start" })
      .select()
      .single();
    if (error) throw error;
    res.json({ goal: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

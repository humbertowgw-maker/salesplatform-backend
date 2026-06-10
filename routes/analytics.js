// routes/analytics.js — Sales analytics computed from existing DB data
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

// GET /api/analytics/overview
// Returns KPIs, outcome distribution, daily volume, hourly heatmap, rep perf, objections
router.get("/overview", async (req, res) => {
  const days = parseInt(req.query.days || "90");
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const [callsRes, leadsRes, apptsRes, objRes] = await Promise.allSettled([
      // Call logs — no transcripts for perf
      supabase.from("call_logs")
        .select("id, outcome, status, duration_seconds, answered_by, rep_name, created_at")
        .gte("created_at", since)
        .limit(5000),

      // All leads — status counts
      supabase.from("leads").select("id, status"),

      // Appointments in window
      supabase.from("appointments")
        .select("id, rep_id, booked_by, status, created_at")
        .gte("created_at", since),

      // Transcripts for objection mining — only not-interested calls, last 200
      supabase.from("call_logs")
        .select("transcript, outcome")
        .eq("outcome", "not_interested")
        .not("transcript", "is", null)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    const calls  = callsRes.status  === "fulfilled" ? callsRes.value.data  || [] : [];
    const leads  = leadsRes.status  === "fulfilled" ? leadsRes.value.data  || [] : [];
    const appts  = apptsRes.status  === "fulfilled" ? apptsRes.value.data  || [] : [];
    const objRaw = objRes.status    === "fulfilled" ? objRes.value.data    || [] : [];

    // ── KPIs ──────────────────────────────────────────────────────────────────
    const totalCalls    = calls.length;
    const humanAnswered = calls.filter(c => c.answered_by === "human" || (c.duration_seconds || 0) > 20).length;
    const booked        = calls.filter(c => c.outcome === "appointment_booked").length;
    const totalLeads    = leads.length;
    const converted     = leads.filter(l => l.status === "Converted").length;

    const kpis = {
      total_calls:   totalCalls,
      answer_rate:   totalCalls > 0 ? Math.round((humanAnswered / totalCalls) * 100) : 0,
      booking_rate:  humanAnswered > 0 ? Math.round((booked / humanAnswered) * 100) : 0,
      close_rate:    totalLeads > 0 ? Math.round((converted / totalLeads) * 100) : 0,
      total_appts:   appts.length,
      total_leads:   totalLeads,
    };

    // ── Outcome distribution ──────────────────────────────────────────────────
    const outcomeCounts = {};
    for (const c of calls) {
      const k = c.outcome || c.status || "unknown";
      outcomeCounts[k] = (outcomeCounts[k] || 0) + 1;
    }
    const outcomeOrder = ["appointment_booked","callback_requested","not_interested","voicemail","no_answer","hung_up","completed","unknown"];
    const outcomeColors = {
      appointment_booked: "#10b981", callback_requested: "#60a5fa", completed: "#94a3b8",
      not_interested: "#ef4444", voicemail: "#a78bfa", no_answer: "#f97316",
      hung_up: "#f43f5e", unknown: "#334155",
    };
    const outcome_dist = outcomeOrder
      .filter(k => outcomeCounts[k])
      .map(k => ({
        outcome: k,
        count:   outcomeCounts[k],
        pct:     totalCalls > 0 ? Math.round((outcomeCounts[k] / totalCalls) * 100) : 0,
        color:   outcomeColors[k] || "#475569",
      }));

    // ── Lead status funnel ────────────────────────────────────────────────────
    const statusOrder = ["New","Called","Texted","Follow Up","No Answer","Voicemail","Hung Up","Not Interested","Appt Set","Converted"];
    const statusColors = {
      "New":"#94a3b8","Called":"#60a5fa","Texted":"#a78bfa","Follow Up":"#fbbf24",
      "No Answer":"#f97316","Voicemail":"#c084fc","Hung Up":"#f87171",
      "Not Interested":"#78716c","Appt Set":"#4ade80","Converted":"#34d399",
    };
    const statusCounts = {};
    for (const l of leads) statusCounts[l.status||"New"] = (statusCounts[l.status||"New"]||0)+1;
    const lead_funnel = statusOrder
      .filter(s => statusCounts[s])
      .map(s => ({ status: s, count: statusCounts[s], color: statusColors[s]||"#475569" }));

    // ── Daily call volume — last 30 days ──────────────────────────────────────
    const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dailyCounts = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(thirtyAgo.getTime() + i * 86400000);
      dailyCounts[d.toISOString().slice(0,10)] = 0;
    }
    for (const c of calls) {
      const d = (c.created_at||"").slice(0,10);
      if (dailyCounts[d] !== undefined) dailyCounts[d]++;
    }
    const daily_calls = Object.entries(dailyCounts).map(([date,count]) => ({ date, count }));

    // ── Hourly distribution (best times to call) ──────────────────────────────
    const hourCounts = Array.from({length:24}, (_,h) => ({ hour:h, calls:0, answered:0 }));
    for (const c of calls) {
      const h = new Date(c.created_at||0).getHours();
      if (h >= 0 && h < 24) {
        hourCounts[h].calls++;
        if (c.answered_by === "human" || (c.duration_seconds||0) > 20) hourCounts[h].answered++;
      }
    }
    const hourly = hourCounts.map(h => ({
      ...h,
      answer_rate: h.calls > 0 ? Math.round((h.answered / h.calls) * 100) : 0,
    }));

    // ── Rep performance ───────────────────────────────────────────────────────
    const repMap = {};
    for (const c of calls) {
      const name = c.rep_name || "Unassigned";
      if (!repMap[name]) repMap[name] = { calls:0, answered:0, booked:0 };
      repMap[name].calls++;
      if (c.answered_by === "human" || (c.duration_seconds||0) > 20) repMap[name].answered++;
      if (c.outcome === "appointment_booked") repMap[name].booked++;
    }
    const rep_perf = Object.entries(repMap)
      .map(([name, d]) => ({
        name,
        calls:       d.calls,
        answered:    d.answered,
        booked:      d.booked,
        answer_rate: d.calls > 0 ? Math.round((d.answered / d.calls) * 100) : 0,
        booking_rate: d.answered > 0 ? Math.round((d.booked / d.answered) * 100) : 0,
      }))
      .sort((a,b) => b.booked - a.booked);

    // ── Top objections (keyword mining on not-interested transcripts) ─────────
    const OBJECTION_PATTERNS = [
      { label: "Already have a provider",  terms: ["already have","current provider","have internet","have service"] },
      { label: "Not interested",           terms: ["not interested","no thanks","no thank you","don't need"] },
      { label: "Too busy / bad timing",    terms: ["busy","bad time","not a good time","call later","call back"] },
      { label: "Do not call",              terms: ["do not call","don't call","stop calling","remove me","take me off"] },
      { label: "Talking to AI / robot",    terms: ["robot","automated","is this a bot","is this ai","machine"] },
      { label: "No English / Language",   terms: ["no english","no habla","español","hablar con"] },
      { label: "Owner not available",      terms: ["owner","manager","not here","not available","come back"] },
      { label: "Just opened / too new",    terms: ["just opened","new business","just started","recently opened"] },
    ];
    const allText = objRaw.map(r => (r.transcript||"").toLowerCase()).join(" ");
    const objections = OBJECTION_PATTERNS
      .map(p => ({
        label: p.label,
        count: p.terms.reduce((sum, t) => {
          let n = 0, pos = 0;
          while ((pos = allText.indexOf(t, pos)) !== -1) { n++; pos += t.length; }
          return sum + n;
        }, 0),
      }))
      .filter(o => o.count > 0)
      .sort((a,b) => b.count - a.count);

    res.json({ kpis, outcome_dist, lead_funnel, daily_calls, hourly, rep_perf, objections, window_days: days });

  } catch (err) {
    console.error("[analytics] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

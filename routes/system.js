// routes/system.js — System health dashboard data
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");
const telegram = require("../lib/telegram");

// GET /api/system/health — aggregated health snapshot
router.get("/health", async (req, res) => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Run all queries in parallel
    const [callsRes, smsRes, apptRes, recentCallsRes] = await Promise.allSettled([
      // Call stats last 24h
      supabase.from("call_logs").select("status, outcome, created_at").gte("created_at", since24h),
      // SMS stats last 24h
      supabase.from("text_logs").select("direction, status, created_at").gte("created_at", since24h),
      // Appointments last 7 days
      supabase.from("appointments").select("status, created_at").gte("created_at", since7d),
      // Last 10 call log entries for recent activity
      supabase.from("call_logs")
        .select("id, business_name, phone_number, status, outcome, duration_seconds, created_at")
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    const calls   = callsRes.status === "fulfilled"       ? callsRes.value.data || []       : [];
    const sms     = smsRes.status === "fulfilled"         ? smsRes.value.data || []         : [];
    const appts   = apptRes.status === "fulfilled"        ? apptRes.value.data || []        : [];
    const recent  = recentCallsRes.status === "fulfilled" ? recentCallsRes.value.data || [] : [];

    // Call breakdown
    const callStats = {
      total:         calls.length,
      completed:     calls.filter(c => c.status === "completed").length,
      no_answer:     calls.filter(c => c.outcome === "no_answer").length,
      voicemail:     calls.filter(c => c.outcome === "voicemail").length,
      failed:        calls.filter(c => c.status === "failed" || c.status === "error").length,
      appt_booked:   calls.filter(c => c.outcome === "appointment_booked").length,
    };

    // SMS breakdown
    const smsStats = {
      total:         sms.length,
      outbound:      sms.filter(s => s.direction === "outbound").length,
      inbound:       sms.filter(s => s.direction === "inbound").length,
      failed:        sms.filter(s => s.status === "failed" || s.status === "undelivered").length,
    };

    // Appointment breakdown
    const apptStats = {
      total:     appts.length,
      confirmed: appts.filter(a => a.status === "Confirmed").length,
      pending:   appts.filter(a => a.status === "Pending").length,
      cancelled: appts.filter(a => a.status === "Cancelled").length,
      no_show:   appts.filter(a => a.status === "No Show").length,
    };

    // Service configuration status (keys present = configured)
    const services = {
      supabase:    process.env.SUPABASE_URL         ? "configured" : "missing",
      bland:       (process.env.BLAND_API_KEY || process.env.BLAND_KEY) ? "configured" : "missing",
      twilio:      process.env.TWILIO_ACCOUNT_SID   ? "configured" : "missing",
      anthropic:   process.env.ANTHROPIC_API_KEY    ? "configured" : "missing",
      google_cal:  process.env.GOOGLE_CLIENT_ID     ? "configured" : "missing",
      telegram:    telegram.isConfigured()           ? "configured" : "missing",
      stripe:      process.env.STRIPE_SECRET_KEY    ? "configured" : "missing",
    };

    // Overall health label
    const missingCritical = ["bland", "twilio", "anthropic", "supabase"]
      .filter(k => services[k] === "missing");
    const health = missingCritical.length > 0 ? "warning"
      : callStats.failed > 3               ? "warning"
      : "healthy";

    res.json({ health, services, calls_24h: callStats, sms_24h: smsStats, appts_7d: apptStats, recent_calls: recent });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/system/test-telegram — send a test ping
router.post("/test-telegram", async (req, res) => {
  if (!telegram.isConfigured()) {
    return res.status(400).json({ error: "Telegram not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to your env." });
  }
  try {
    await telegram.sendMessage("✅ <b>TEST PING</b>\n\nYour Sales Platform notifications are working!");
    res.json({ sent: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/system/report-error — frontend error boundary reports here
router.post("/report-error", async (req, res) => {
  const { message, stack, component, url, userAgent } = req.body || {};
  const summary = `🔴 <b>Frontend Error</b>\n\n<b>Msg:</b> ${message||"unknown"}\n<b>Component:</b> ${component||"?"}\n<b>URL:</b> ${url||"?"}\n\n<code>${(stack||"").slice(0,400)}</code>`;
  console.error("[frontend-error]", message, component);
  // Fire-and-forget Telegram alert (don't block response)
  telegram.sendAlert(summary).catch(()=>{});
  res.json({ received: true });
});

module.exports = router;

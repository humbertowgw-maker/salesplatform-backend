// routes/automation.js — Follow-up automation: find stale leads and re-call them
const express  = require("express");
const axios    = require("axios");
const router   = express.Router();
const supabase = require("../db/supabase");
const telegram = require("../lib/telegram");
const { buildCallScript } = require("../lib/callScript");

// In-memory state for scheduler (resets on restart — cheap and sufficient)
const state = {
  lastRun:      null,
  lastResult:   null,
  running:      false,
  runCount:     0,
  paused:       false,
};

// ── CORE FOLLOW-UP LOGIC ──────────────────────────────────────────────────────
// Exported so lib/scheduler.js can also call it directly.
async function runFollowups({ orgId = null } = {}) {
  if (state.running) return { skipped_reason: "already_running" };
  if (state.paused)  return { skipped_reason: "paused" };
  state.running = true;

  const MAX_ATTEMPTS = parseInt(process.env.FOLLOWUP_MAX_ATTEMPTS || "3");
  const MIN_DAYS     = parseFloat(process.env.FOLLOWUP_MIN_DAYS    || "2");
  const BATCH_SIZE   = parseInt(process.env.FOLLOWUP_BATCH_SIZE    || "10");
  const blandKey     = process.env.BLAND_KEY || process.env.BLAND_API_KEY;

  let triggered = 0, skipped = 0, errors = 0;

  try {
    // Fetch candidates: leads that haven't converted and haven't been called too many times
    const FOLLOWUP_STATUSES = ["No Answer", "Voicemail", "Follow Up", "Called"];
    let query = supabase
      .from("leads")
      .select("id, business_name, phone, status, call_attempts, rep_id, city, owner_name, current_provider")
      .in("status", FOLLOWUP_STATUSES)
      .not("phone", "is", null)
      .order("call_attempts", { ascending: true })
      .limit(BATCH_SIZE * 4); // over-fetch so we can filter by time

    const { data: candidates, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;
    if (!candidates?.length) {
      state.lastRun = new Date().toISOString();
      state.lastResult = { triggered: 0, skipped: 0, errors: 0, leads_checked: 0 };
      state.running = false;
      return state.lastResult;
    }

    // Filter: under max attempt cap
    const eligible = candidates.filter(l => (l.call_attempts || 0) < MAX_ATTEMPTS);

    // Filter: not called within MIN_DAYS
    const cutoff  = new Date(Date.now() - MIN_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const toCall  = [];

    for (const lead of eligible) {
      if (toCall.length >= BATCH_SIZE) break;
      const { data: recentCall } = await supabase
        .from("call_logs")
        .select("created_at")
        .eq("lead_id", lead.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const lastCalledAt = recentCall?.created_at;
      if (!lastCalledAt || lastCalledAt < cutoff) {
        toCall.push(lead);
      } else {
        skipped++;
      }
    }

    // Trigger calls
    for (let i = 0; i < toCall.length; i++) {
      const lead = toCall[i];
      try {
        if (!blandKey) { skipped++; continue; }

        const { data: rep } = lead.rep_id
          ? await supabase.from("reps").select("name").eq("id", lead.rep_id).single()
          : { data: null };
        const repName = rep?.name || "our local specialist";

        const rawPhone = lead.phone.replace(/\D/g, "");
        const phone    = rawPhone.startsWith("1") ? `+${rawPhone}` : `+1${rawPhone}`;

        const task = buildCallScript({
          businessName:    lead.business_name,
          ownerName:       lead.owner_name,
          city:            lead.city,
          currentProvider: lead.current_provider,
          repName,
        });

        const blandRes = await axios.post(
          "https://us.api.bland.ai/v1/calls",
          {
            phone_number: phone, task, model: "enhanced", language: "auto",
            voice: "maya", max_duration: 12, wait_for_greeting: true, record: true,
            interruption_threshold: 100, temperature: 0.7,
            webhook: `${process.env.WEBHOOK_BASE_URL}/api/webhooks/bland`,
            metadata: {
              lead_id:   lead.id,
              business_name: lead.business_name,
              rep_name:  repName,
              automated: true,
            },
          },
          { headers: { "Content-Type": "application/json", authorization: blandKey }, timeout: 30000 }
        );

        const callId = blandRes.data?.call_id;
        await supabase.from("call_logs").insert({
          lead_id:       lead.id,
          bland_call_id: callId,
          phone_number:  lead.phone,
          business_name: lead.business_name,
          rep_name:      repName,
          language:      "auto",
          status:        "initiated",
        });
        await supabase.from("leads").update({ status: "Called" }).eq("id", lead.id);
        triggered++;

        // Stagger calls 3 seconds apart
        if (i < toCall.length - 1) await new Promise(r => setTimeout(r, 3000));

      } catch (e) {
        console.error(`[automation] Call failed for ${lead.business_name}:`, e.message);
        errors++;
      }
    }

    await telegram.sendFollowupSummary({ triggered, skipped, errors });

    state.runCount++;
    state.lastRun    = new Date().toISOString();
    state.lastResult = { triggered, skipped, errors, leads_checked: eligible.length };
    return state.lastResult;

  } finally {
    state.running = false;
  }
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// POST /api/automation/run — manually trigger follow-up run
router.post("/run", async (req, res) => {
  try {
    const result = await runFollowups({ orgId: req.orgId });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[automation] run error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/automation/status — scheduler state + queue preview
router.get("/status", async (req, res) => {
  try {
    const FOLLOWUP_STATUSES = ["No Answer", "Voicemail", "Follow Up", "Called"];
    const MAX_ATTEMPTS = parseInt(process.env.FOLLOWUP_MAX_ATTEMPTS || "3");

    const { count } = await supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .in("status", FOLLOWUP_STATUSES)
      .not("phone", "is", null)
      .lt("call_attempts", MAX_ATTEMPTS);

    const intervalHours = parseInt(process.env.FOLLOWUP_INTERVAL_HOURS || "6");
    const nextRun = state.lastRun
      ? new Date(new Date(state.lastRun).getTime() + intervalHours * 60 * 60 * 1000).toISOString()
      : null;

    res.json({
      running:        state.running,
      paused:         state.paused,
      last_run:       state.lastRun,
      last_result:    state.lastResult,
      next_run:       nextRun,
      run_count:      state.runCount,
      queue_size:     count || 0,
      config: {
        interval_hours: intervalHours,
        max_attempts:   MAX_ATTEMPTS,
        min_days:       parseFloat(process.env.FOLLOWUP_MIN_DAYS    || "2"),
        batch_size:     parseInt(process.env.FOLLOWUP_BATCH_SIZE    || "10"),
        scheduler_on:   process.env.DISABLE_SCHEDULER !== "true",
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/automation/pause — pause the scheduler (AI calls won't fire)
router.post("/pause", (req, res) => {
  state.paused = true;
  res.json({ ok: true, paused: true });
});

// POST /api/automation/resume — resume the scheduler
router.post("/resume", (req, res) => {
  state.paused = false;
  res.json({ ok: true, paused: false });
});

module.exports = router;
module.exports.runFollowups = runFollowups;

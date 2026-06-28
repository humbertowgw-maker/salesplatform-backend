// lib/scheduler.js — Background automation scheduler
// Uses plain setInterval — no extra dependencies needed.

function startScheduler() {
  if (process.env.DISABLE_SCHEDULER === "true") {
    console.log("[scheduler] Disabled via DISABLE_SCHEDULER=true");
    return;
  }

  const intervalHours = parseInt(process.env.FOLLOWUP_INTERVAL_HOURS || "6");
  const intervalMs    = intervalHours * 60 * 60 * 1000;
  console.log(`[scheduler] Follow-up automation: every ${intervalHours}h`);

  // ── Follow-up calls: first run 3 min after boot, then on interval ──────────
  setTimeout(async () => {
    const { runFollowups } = require("../routes/automation");
    const runFollowupJob = async () => {
      try {
        console.log("[scheduler] Running follow-up automation...");
        const result = await runFollowups();
        console.log("[scheduler] Follow-ups done:", result);
      } catch (e) { console.error("[scheduler] Follow-up error:", e.message); }
    };
    await runFollowupJob();
    setInterval(runFollowupJob, intervalMs);
  }, 3 * 60 * 1000);

  // ── Queue Health: every 6 hours ───────────────────────────────────────────
  setTimeout(async () => {
    const runHealth = async () => {
      try {
        const { runQueueHealth } = require("../lib/agents/queueHealth");
        const supabase = require("../db/supabase");
        const { data: orgs } = await supabase.from("organizations").select("id").eq("plan_status", "active");
        for (const org of orgs || []) await runQueueHealth(org.id);
        console.log("[scheduler] Queue health cycle complete");
      } catch (e) { console.error("[scheduler] Queue health error:", e.message); }
    };
    await runHealth();
    setInterval(runHealth, 6 * 60 * 60 * 1000);
  }, 5 * 60 * 1000); // first run 5 min after boot

  // ── Lead Scout: 2 AM UTC daily ─────────────────────────────────────────────
  scheduleDailyAtUTC(2, 0, async () => {
    try {
      const { runLeadScout } = require("../lib/agents/leadScout");
      const supabase = require("../db/supabase");
      const { data: orgs } = await supabase.from("organizations").select("id").eq("plan_status", "active");
      for (const org of orgs || []) {
        const result = await runLeadScout({ orgId: org.id });
        console.log(`[scheduler] Lead scout org ${org.id}:`, result);
      }
    } catch (e) { console.error("[scheduler] Lead scout error:", e.message); }
  });

  // ── Follow-up: 3 AM UTC daily (supplementing the existing interval run) ───
  scheduleDailyAtUTC(3, 0, async () => {
    try {
      const { runFollowups } = require("../routes/automation");
      await runFollowups();
      console.log("[scheduler] Nightly follow-up run complete");
    } catch (e) { console.error("[scheduler] Nightly follow-up error:", e.message); }
  });

  // ── EOD Report: 11 PM UTC daily ───────────────────────────────────────────
  scheduleDailyAtUTC(23, 0, async () => {
    try {
      const { runEodReport } = require("../lib/agents/eodReport");
      const supabase = require("../db/supabase");
      const { data: orgs } = await supabase.from("organizations").select("id").eq("plan_status", "active");
      for (const org of orgs || []) {
        const result = await runEodReport(org.id);
        console.log(`[scheduler] EOD report org ${org.id}: ${result.summary?.slice(0, 80)}...`);
      }
    } catch (e) { console.error("[scheduler] EOD report error:", e.message); }
  });

  // ── Director: daily briefing at 8 AM local time ────────────────────────────
  scheduleDailyAt(8, 0, async () => {
    try {
      const { buildDailyBriefing, autoAssignTasks } = require("./director");
      const telegram = require("./telegram");
      const supabase = require("../db/supabase");

      // Get all distinct org IDs
      const { data: orgs } = await supabase
        .from("organizations").select("id").eq("plan_status", "active");

      for (const org of orgs || []) {
        console.log(`[scheduler] Building director briefing for org ${org.id}`);
        const content = await buildDailyBriefing(org.id);
        const { count } = await supabase
          .from("reps").select("id", { count: "exact", head: true }).eq("active", true);
        await telegram.sendDirectorBriefing({
          content,
          date: new Date().toISOString().slice(0, 10),
          repCount: count || 0,
        });
        await autoAssignTasks(org.id);
      }
    } catch (e) { console.error("[scheduler] Briefing error:", e.message); }
  });

  // ── Director: performance assessment every 4 hours ─────────────────────────
  setTimeout(async () => {
    const runAssessment = async () => {
      try {
        const { runPerformanceAssessment, autoAssignTasks } = require("./director");
        const supabase = require("../db/supabase");
        const { data: orgs } = await supabase
          .from("organizations").select("id");
        for (const org of orgs || []) {
          await runPerformanceAssessment(org.id);
          await autoAssignTasks(org.id);
        }
      } catch (e) { console.error("[scheduler] Assessment error:", e.message); }
    };
    await runAssessment();
    setInterval(runAssessment, 4 * 60 * 60 * 1000);
  }, 10 * 60 * 1000); // first run 10 min after boot
}

// Schedule a job to run once per day at a given hour:minute (UTC)
function scheduleDailyAtUTC(hour, minute, fn) {
  const msUntilNext = () => {
    const now  = new Date();
    const next = new Date(now);
    next.setUTCHours(hour, minute, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next - now;
  };
  const scheduleNext = () => {
    setTimeout(async () => {
      await fn().catch(e => console.error("[scheduler] UTC daily job error:", e.message));
      scheduleNext();
    }, msUntilNext());
  };
  scheduleNext();
}

// Schedule a job to run once per day at a given hour:minute (server local time)
function scheduleDailyAt(hour, minute, fn) {
  const msUntilNext = () => {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };
  const scheduleNext = () => {
    setTimeout(async () => {
      await fn().catch(e => console.error("[scheduler] Daily job error:", e.message));
      scheduleNext();
    }, msUntilNext());
  };
  scheduleNext();
}

module.exports = { startScheduler };

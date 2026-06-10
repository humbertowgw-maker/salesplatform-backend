// lib/scheduler.js — Background follow-up automation scheduler
// Uses plain setInterval — no extra dependencies needed.

function startScheduler() {
  if (process.env.DISABLE_SCHEDULER === "true") {
    console.log("[scheduler] Disabled via DISABLE_SCHEDULER=true");
    return;
  }

  const intervalHours = parseInt(process.env.FOLLOWUP_INTERVAL_HOURS || "6");
  const intervalMs    = intervalHours * 60 * 60 * 1000;

  console.log(`[scheduler] Follow-up automation: every ${intervalHours}h`);

  // First run after 3 minutes so the server finishes booting before any calls go out
  const INITIAL_DELAY_MS = 3 * 60 * 1000;

  setTimeout(async () => {
    const { runFollowups } = require("../routes/automation");
    const run = async () => {
      try {
        console.log("[scheduler] Running follow-up automation...");
        const result = await runFollowups();
        console.log("[scheduler] Done:", result);
      } catch (e) {
        console.error("[scheduler] Error:", e.message);
      }
    };

    await run();
    setInterval(run, intervalMs);
  }, INITIAL_DELAY_MS);
}

module.exports = { startScheduler };

// lib/director.js — Artificial Director: AI operations coordinator
// Manages daily briefings, performance assessment, task assignment, escalation.
// NEVER fires termination, discipline, or pay changes without admin approval.
const axios    = require("axios");
const supabase = require("../db/supabase");
const telegram = require("./telegram");

// ── HELPERS ───────────────────────────────────────────────────────────────────

function weekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function askClaude(system, userMsg, maxTokens = 600) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userMsg }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        timeout: 20000,
      }
    );
    return res.data?.content?.[0]?.text || null;
  } catch (e) {
    console.warn("[director] Claude error:", e.message);
    return null;
  }
}

// ── REP KPI SNAPSHOT ──────────────────────────────────────────────────────────
// Returns performance data for a single rep over a rolling window.
async function getRepStats(repId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [callsRes, apptsRes, leadsRes, tasksRes, goalsRes] = await Promise.allSettled([
    supabase.from("call_logs")
      .select("id, outcome, status, duration_seconds, created_at")
      .eq("rep_id", repId)
      .gte("created_at", since),
    supabase.from("appointments")
      .select("id, status, created_at")
      .eq("rep_id", repId)
      .gte("created_at", since),
    supabase.from("leads")
      .select("id, status")
      .eq("rep_id", repId),
    supabase.from("rep_tasks")
      .select("id, status, priority, title, due_date")
      .eq("rep_id", repId)
      .eq("status", "open"),
    supabase.from("rep_goals")
      .select("calls_target, appts_target")
      .eq("rep_id", repId)
      .eq("week_start", weekStart())
      .maybeSingle(),
  ]);

  const calls  = callsRes.status  === "fulfilled" ? callsRes.value.data  || [] : [];
  const appts  = apptsRes.status  === "fulfilled" ? apptsRes.value.data  || [] : [];
  const leads  = leadsRes.status  === "fulfilled" ? leadsRes.value.data  || [] : [];
  const tasks  = tasksRes.status  === "fulfilled" ? tasksRes.value.data  || [] : [];
  const goals  = goalsRes.status  === "fulfilled" ? goalsRes.value.data  || null : null;

  const callsToday = calls.filter(c =>
    new Date(c.created_at) >= today
  ).length;

  const answered = calls.filter(c =>
    c.answered_by === "human" || (c.duration_seconds || 0) > 20
  ).length;

  const booked = appts.length;
  const answerRate  = calls.length > 0 ? Math.round((answered / calls.length) * 100) : 0;
  const bookingRate = answered > 0 ? Math.round((booked / answered) * 100) : 0;

  const overdueTaskCount = tasks.filter(t =>
    t.due_date && t.due_date < todayStr()
  ).length;

  return {
    calls_period:    calls.length,
    calls_today:     callsToday,
    answered,
    appts_booked:    booked,
    answer_rate:     answerRate,
    booking_rate:    bookingRate,
    total_leads:     leads.length,
    open_tasks:      tasks.length,
    overdue_tasks:   overdueTaskCount,
    goals_calls:     goals?.calls_target || 30,
    goals_appts:     goals?.appts_target || 5,
    goal_pct_calls:  goals?.calls_target > 0
      ? Math.round((calls.length / goals.calls_target) * 100)
      : null,
    goal_pct_appts:  goals?.appts_target > 0
      ? Math.round((booked / goals.appts_target) * 100)
      : null,
  };
}

// ── DAILY BRIEFING ────────────────────────────────────────────────────────────
async function buildDailyBriefing(orgId) {
  const today = todayStr();

  // Fetch all active reps for org
  const { data: reps } = await supabase
    .from("reps")
    .select("id, name, title, territory")
    .eq("active", true);

  if (!reps?.length) return null;

  // Gather stats for all reps
  const repStats = await Promise.all(
    reps.map(async r => ({ rep: r, stats: await getRepStats(r.id, 7) }))
  );

  // Pending approvals
  const { data: pending } = await supabase
    .from("director_actions")
    .select("id, action_type, target_rep_name, created_at, payload")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .eq("requires_approval", true)
    .order("created_at", { ascending: false })
    .limit(5);

  const repSummaryLines = repStats.map(({ rep, stats }) =>
    `- ${rep.name}${rep.title ? ` (${rep.title})` : ""}: ` +
    `${stats.calls_period} calls this week (${stats.goal_pct_calls ?? "?"}% of goal), ` +
    `${stats.appts_booked} appts (${stats.goal_pct_appts ?? "?"}% of goal), ` +
    `${stats.calls_today} calls today, ` +
    `${stats.open_tasks} open tasks${stats.overdue_tasks > 0 ? ` — ⚠️ ${stats.overdue_tasks} OVERDUE` : ""}`
  ).join("\n");

  const pendingLines = pending?.length
    ? `\nPENDING APPROVALS (${pending.length}):\n` +
      pending.map(a => `- ${a.action_type} for ${a.target_rep_name}: ${JSON.stringify(a.payload)}`).join("\n")
    : "";

  const briefingText = await askClaude(
    `You are the Artificial Director — an AI operations coordinator for a B2B sales team.
Write a concise daily briefing for the sales manager. Focus on:
1. Who is performing well (positive reinforcement)
2. Who needs attention today (behind on calls, overdue tasks)
3. One or two specific recommended actions for today
4. Flag any team-wide patterns or concerns

Tone: direct, professional, like a COO's morning brief. No fluff. Max 200 words.
Format: plain text with short paragraphs. No markdown headers.`,
    `Today is ${today}. Here is the team snapshot:\n\n${repSummaryLines}${pendingLines}\n\nWrite the daily briefing.`,
    500
  ) || `Daily briefing for ${today}: ${reps.length} active reps. ${repStats.reduce((s, r) => s + r.stats.calls_period, 0)} calls this week across the team.`;

  // Upsert org-wide briefing
  await supabase.from("director_briefings").upsert({
    org_id:         orgId,
    rep_id:         null,
    briefing_date:  today,
    type:           "daily",
    content:        briefingText,
  }, { onConflict: "org_id,rep_id,briefing_date,type" });

  // Build per-rep briefings
  for (const { rep, stats } of repStats) {
    const repText = await askClaude(
      `You are the Artificial Director. Write a brief, encouraging daily note for an individual sales rep.
Be specific to their numbers. 2-3 sentences max. Start with their name. Positive but honest.
Never mention pay, termination, or HR matters.`,
      `Rep: ${rep.name}. Week calls: ${stats.calls_period}/${stats.goals_calls}, today: ${stats.calls_today}. ` +
      `Appts: ${stats.appts_booked}/${stats.goals_appts}. Answer rate: ${stats.answer_rate}%. ` +
      `Open tasks: ${stats.open_tasks}${stats.overdue_tasks > 0 ? `, overdue: ${stats.overdue_tasks}` : ""}. ` +
      `Write a short personal briefing note.`,
      200
    ) || `Hi ${rep.name} — you have ${stats.calls_period} calls this week. Keep pushing toward your goal of ${stats.goals_calls} calls.`;

    await supabase.from("director_briefings").upsert({
      org_id:        orgId,
      rep_id:        rep.id,
      briefing_date: today,
      type:          "daily",
      content:       repText,
    }, { onConflict: "org_id,rep_id,briefing_date,type" });
  }

  return briefingText;
}

// ── AUTO TASK ASSIGNMENT ──────────────────────────────────────────────────────
// Creates tasks for reps who are behind. No approval required.
async function autoAssignTasks(orgId) {
  const { data: reps } = await supabase
    .from("reps")
    .select("id, name")
    .eq("active", true)
    .eq("employment_status", "active");

  if (!reps?.length) return { tasks_created: 0 };

  let tasksCreated = 0;
  const today = todayStr();

  for (const rep of reps) {
    const stats = await getRepStats(rep.id, 7);

    // Rep has made zero calls today → assign a task
    if (stats.calls_today === 0) {
      // Don't create duplicate task for today
      const { data: existing } = await supabase
        .from("rep_tasks")
        .select("id")
        .eq("rep_id", rep.id)
        .eq("due_date", today)
        .ilike("title", "%calls today%")
        .maybeSingle();

      if (!existing) {
        await supabase.from("rep_tasks").insert({
          rep_id:      rep.id,
          org_id:      orgId,
          title:       "Make your first calls today",
          description: `You haven't made any calls yet today. Work through your lead list — even 5 calls makes a difference.`,
          due_date:    today,
          priority:    "high",
          assigned_by: "director",
        });
        tasksCreated++;
      }
    }

    // Rep is below 40% of weekly call goal mid-week
    const dayOfWeek = new Date().getDay(); // 3 = Wednesday
    if (dayOfWeek >= 3 && stats.goal_pct_calls !== null && stats.goal_pct_calls < 40) {
      const { data: existing } = await supabase
        .from("rep_tasks")
        .select("id")
        .eq("rep_id", rep.id)
        .ilike("title", "%weekly call goal%")
        .gte("created_at", new Date(Date.now() - 3 * 86400000).toISOString())
        .maybeSingle();

      if (!existing) {
        await supabase.from("rep_tasks").insert({
          rep_id:      rep.id,
          org_id:      orgId,
          title:       "Catch up on weekly call goal",
          description: `You're at ${stats.goal_pct_calls}% of your weekly call goal (${stats.calls_period}/${stats.goals_calls}). A focused push today can close the gap.`,
          due_date:    today,
          priority:    "urgent",
          assigned_by: "director",
        });
        tasksCreated++;
      }
    }
  }

  return { tasks_created: tasksCreated };
}

// ── FLAG FOR MANAGER REVIEW ───────────────────────────────────────────────────
// Always requires admin approval. Sends Telegram immediately.
async function flagForManagerReview(repId, orgId, reason, severity = "medium", payload = {}) {
  const { data: rep } = await supabase
    .from("reps").select("name").eq("id", repId).maybeSingle();

  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  const { data: action } = await supabase
    .from("director_actions")
    .insert({
      org_id:            orgId,
      action_type:       "performance_flag",
      target_rep_id:     repId,
      target_rep_name:   rep?.name || "Unknown",
      payload:           { reason, severity, ...payload },
      requires_approval: true,
      status:            "pending",
      expires_at:        expires,
    })
    .select()
    .single();

  const severityLabel = { low: "📋", medium: "⚠️", high: "🔴" }[severity] || "⚠️";
  await telegram.sendMessage(
    `${severityLabel} <b>DIRECTOR ALERT — Manager Review Required</b>\n\n` +
    `<b>Rep:</b> ${rep?.name || "Unknown"}\n` +
    `<b>Reason:</b> ${reason}\n` +
    `<b>Severity:</b> ${severity}\n\n` +
    `Approve or reject in the Director dashboard.\n` +
    `<i>Auto-expires in 48h if no action taken.</i>`
  );

  return action;
}

// ── WORKLOAD BALANCE ──────────────────────────────────────────────────────────
// Detects unequal lead distribution. Creates approval-required action if imbalanced.
async function checkWorkloadBalance(orgId) {
  const { data: reps } = await supabase
    .from("reps").select("id, name").eq("active", true).eq("employment_status", "active");

  if (!reps?.length) return { balanced: true };

  const counts = await Promise.all(
    reps.map(async r => {
      const { count } = await supabase
        .from("leads").select("id", { count: "exact", head: true })
        .eq("rep_id", r.id)
        .not("status", "in", '("Converted","Not Interested")');
      return { ...r, leads: count || 0 };
    })
  );

  const mean = counts.reduce((s, r) => s + r.leads, 0) / counts.length;
  const overloaded = counts.filter(r => mean > 0 && r.leads > mean * 1.4);
  const underloaded = counts.filter(r => r.leads < mean * 0.6 && r.leads < mean - 5);

  if (!overloaded.length || !underloaded.length) return { balanced: true, counts };

  // Create one approval-required rebalance action
  const { data: existing } = await supabase
    .from("director_actions")
    .select("id")
    .eq("org_id", orgId)
    .eq("action_type", "workload_rebalance")
    .eq("status", "pending")
    .maybeSingle();

  if (!existing) {
    await supabase.from("director_actions").insert({
      org_id:            orgId,
      action_type:       "workload_rebalance",
      target_rep_id:     null,
      target_rep_name:   null,
      payload:           { overloaded, underloaded, mean: Math.round(mean) },
      requires_approval: true,
      status:            "pending",
      expires_at:        new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });

    await telegram.sendMessage(
      `⚖️ <b>DIRECTOR: Workload Imbalance Detected</b>\n\n` +
      overloaded.map(r => `🔴 ${r.name}: ${r.leads} leads (${Math.round((r.leads / mean - 1) * 100)}% above avg)`).join("\n") +
      `\n\n` +
      underloaded.map(r => `🟡 ${r.name}: ${r.leads} leads`).join("\n") +
      `\n\nReview in Director dashboard.`
    );
  }

  return { balanced: false, overloaded, underloaded, mean: Math.round(mean), counts };
}

// ── PERFORMANCE ASSESSMENT ────────────────────────────────────────────────────
// Runs for all reps. Creates flags for reps with consecutive poor weeks.
// Stores week-over-week data in director_actions for pattern detection.
async function runPerformanceAssessment(orgId) {
  const { data: reps } = await supabase
    .from("reps").select("id, name, employment_status").eq("active", true);

  if (!reps?.length) return { assessed: 0 };

  let flagged = 0;
  const results = [];

  for (const rep of reps) {
    if (rep.employment_status === "terminated") continue;

    const stats = await getRepStats(rep.id, 7);
    const pct = stats.goal_pct_calls;

    // Check if this rep was flagged last week too
    const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: priorFlag } = await supabase
      .from("director_actions")
      .select("id")
      .eq("target_rep_id", rep.id)
      .eq("action_type", "performance_flag")
      .gte("created_at", lastWeek)
      .maybeSingle();

    // Two consecutive poor weeks (< 40% of goal) → escalate
    if (pct !== null && pct < 40 && priorFlag) {
      await flagForManagerReview(
        rep.id, orgId,
        `${rep.name} is at ${pct}% of weekly call goal for the second consecutive week (${stats.calls_period} calls vs ${stats.goals_calls} target).`,
        "high",
        { calls: stats.calls_period, goal: stats.goals_calls, answer_rate: stats.answer_rate }
      );
      flagged++;
    } else if (pct !== null && pct < 40) {
      // First poor week — log but don't escalate yet
      await supabase.from("director_actions").insert({
        org_id:            orgId,
        action_type:       "performance_flag",
        target_rep_id:     rep.id,
        target_rep_name:   rep.name,
        payload:           { reason: "Below 40% of weekly call goal", pct, calls: stats.calls_period },
        requires_approval: false,
        status:            "executed",
      });
    }

    results.push({ rep: rep.name, pct, calls: stats.calls_period, flagged: pct < 40 });
  }

  return { assessed: reps.length, flagged, results };
}

module.exports = {
  buildDailyBriefing,
  autoAssignTasks,
  flagForManagerReview,
  checkWorkloadBalance,
  runPerformanceAssessment,
  getRepStats,
};

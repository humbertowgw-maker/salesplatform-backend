// lib/agents/eodReport.js — EOD Report Agent
// Generates nightly summary: metrics, director briefing, improvement suggestions.

const Anthropic = require("@anthropic-ai/sdk");
const supabase  = require("../../db/supabase");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function runEodReport(orgId = null) {
  const today    = new Date().toISOString().slice(0, 10);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();

  // ── Gather metrics ─────────────────────────────────────────────────────────
  const buildQuery = (table, select, since) => {
    let q = supabase.from(table).select(select).gte("created_at", since);
    if (orgId) q = q.eq("org_id", orgId);
    return q;
  };

  const [callsRes, textsRes, apptRes, leadsRes, qhRes] = await Promise.allSettled([
    buildQuery("call_logs",   "status, outcome", since24h),
    buildQuery("text_logs",   "status, direction", since24h),
    buildQuery("appointments","status", since24h),
    supabase.from("leads").select("status, call_attempts").not("status", "in", '("Converted","Not Interested")'),
    supabase.from("queue_health_log").select("health_score, issues").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const calls = callsRes.status === "fulfilled" ? callsRes.value.data || [] : [];
  const texts = textsRes.status === "fulfilled" ? textsRes.value.data || [] : [];
  const appts = apptRes.status === "fulfilled"  ? apptRes.value.data  || [] : [];
  const leads = leadsRes.status === "fulfilled" ? leadsRes.value.data || [] : [];
  const qh    = qhRes.status === "fulfilled"    ? qhRes.value.data       : null;

  const metrics = {
    date: today,
    calls: {
      total:       calls.length,
      completed:   calls.filter(c => c.status === "completed").length,
      voicemail:   calls.filter(c => c.outcome === "voicemail").length,
      no_answer:   calls.filter(c => c.outcome === "no_answer").length,
      booked:      calls.filter(c => c.outcome === "appointment_booked").length,
    },
    texts: {
      total:    texts.length,
      outbound: texts.filter(t => t.direction === "outbound").length,
      inbound:  texts.filter(t => t.direction === "inbound").length,
    },
    appointments: {
      total:     appts.length,
      confirmed: appts.filter(a => a.status === "Confirmed").length,
    },
    leads: {
      active:   leads.length,
      new_today: leads.filter(l => l.call_attempts === 0).length,
    },
    queue_health_score: qh?.health_score ?? null,
  };

  // ── Generate AI briefing + suggestions ────────────────────────────────────
  const prompt = `You are an AI sales operations director reviewing end-of-day metrics for a wireless internet sales team.

Today's metrics (${today}):
- Calls made: ${metrics.calls.total} (${metrics.calls.completed} completed, ${metrics.calls.booked} appointments booked)
- Voicemails left: ${metrics.calls.voicemail}, No answers: ${metrics.calls.no_answer}
- SMS: ${metrics.texts.outbound} sent, ${metrics.texts.inbound} received
- Appointments: ${metrics.appointments.total} today (${metrics.appointments.confirmed} confirmed)
- Active pipeline leads: ${metrics.leads.active} (${metrics.leads.new_today} untouched)
- Queue health score: ${metrics.queue_health_score !== null ? metrics.queue_health_score + "/100" : "N/A"}

Write a concise EOD briefing (3–5 sentences) summarizing performance and flag any concerns.
Then list 2–3 specific, actionable improvement suggestions.

Respond as JSON:
{
  "summary": "...",
  "suggestions": [
    { "text": "...", "priority": "high|normal|low" }
  ]
}`;

  let summary     = `EOD Report for ${today}`;
  let suggestions = [];

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = msg.content?.[0]?.text || "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    summary     = parsed.summary     || summary;
    suggestions = parsed.suggestions || [];
  } catch (e) {
    console.error("[eod-report] AI generation failed:", e.message);
    summary = `EOD for ${today}: calls=${metrics.calls.total}, booked=${metrics.calls.booked}, appointments=${metrics.appointments.total}.`;
  }

  // ── Upsert EOD report ────────────────────────────────────────────────────
  await supabase.from("eod_reports").upsert(
    { org_id: orgId, date: today, summary, metrics, suggestions },
    { onConflict: "org_id,date" }
  );

  // ── Store improvement suggestions ─────────────────────────────────────────
  if (suggestions.length) {
    const rows = suggestions.map(s => ({
      org_id:     orgId,
      suggestion: s.text || s,
      source:     "eod_report",
      priority:   s.priority || "normal",
    }));
    await supabase.from("improvement_suggestions").insert(rows);
  }

  // ── Stamp agent last run ─────────────────────────────────────────────────
  await supabase
    .from("agent_registry")
    .update({ last_run_at: new Date().toISOString(), run_count: supabase.raw("run_count + 1") })
    .eq("slug", "eod-report");

  console.log(`[eod-report] Report generated for ${today} — ${suggestions.length} suggestions`);
  return { date: today, summary, metrics, suggestions };
}

module.exports = { runEodReport };

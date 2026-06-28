// lib/agents/queueHealth.js — Queue Health Agent
// Scans lead pipeline for stale/stuck leads, scores queue health, logs issues.

const supabase = require("../../db/supabase");

const STALE_DAYS      = 5;   // leads not touched in N days are stale
const LOW_SCORE_WARN  = 60;  // health score below this triggers a warning log

async function runQueueHealth(orgId = null) {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Fetch all active (non-terminal) leads for the org
  let query = supabase
    .from("leads")
    .select("id, business_name, status, call_attempts, updated_at, rep_id")
    .not("status", "in", '("Converted","Not Interested")');

  if (orgId) query = query.eq("org_id", orgId);

  const { data: leads, error } = await query;
  if (error) throw error;

  const total     = leads.length;
  const active    = leads.filter(l => l.call_attempts > 0).length;
  const stale     = leads.filter(l => !l.updated_at || l.updated_at < cutoff).length;
  const unassigned = leads.filter(l => !l.rep_id).length;

  // Queue size = pending items in call_queue
  let queueQuery = supabase.from("call_queue").select("id", { count: "exact", head: true }).eq("status", "pending");
  if (orgId) queueQuery = queueQuery.eq("org_id", orgId);
  const { count: queueSize } = await queueQuery;

  const issues = [];
  if (stale > 0)      issues.push({ type: "stale_leads",   count: stale,      message: `${stale} lead(s) not updated in ${STALE_DAYS}+ days` });
  if (unassigned > 0) issues.push({ type: "unassigned",    count: unassigned, message: `${unassigned} lead(s) have no rep assigned` });
  if (queueSize === 0 && total > 0) issues.push({ type: "empty_queue", count: 0, message: "Call queue is empty but active leads exist" });

  // Score: start at 100, subtract for problems
  let score = 100;
  if (total > 0) {
    score -= Math.round((stale    / total) * 40);
    score -= Math.round((unassigned / total) * 20);
  }
  if (queueSize === 0 && total > 0) score -= 15;
  score = Math.max(0, score);

  // Log result
  await supabase.from("queue_health_log").insert({
    org_id:       orgId,
    total_leads:  total,
    active_leads: active,
    stale_leads:  stale,
    queue_size:   queueSize || 0,
    health_score: score,
    issues,
  });

  // Stamp agent last run
  await supabase
    .from("agent_registry")
    .update({ last_run_at: new Date().toISOString(), run_count: supabase.raw("run_count + 1") })
    .eq("slug", "queue-health");

  if (score < LOW_SCORE_WARN) {
    console.warn(`[queue-health] Low health score ${score} for org ${orgId}. Issues:`, issues);
  }

  return { total, active, stale, queue_size: queueSize || 0, health_score: score, issues };
}

module.exports = { runQueueHealth };

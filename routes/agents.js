// routes/agents.js — Agent registry CRUD + lifecycle management
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

// ── GET /api/agents — list all agents ────────────────────────────────────────
router.get("/", async (req, res) => {
  const { data, error } = await supabase
    .from("agent_registry")
    .select("*")
    .order("category")
    .order("name");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/agents/audit — recent audit log ──────────────────────────────────
router.get("/audit", async (req, res) => {
  const limit = parseInt(req.query.limit || "50");
  const { data, error } = await supabase
    .from("agent_audit_log")
    .select("*, agent:agent_id(name, slug)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/agents/queue-health — latest queue health snapshot ───────────────
router.get("/queue-health", async (req, res) => {
  let q = supabase
    .from("queue_health_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(10);
  if (req.orgId) q = q.eq("org_id", req.orgId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/agents/eod-reports — recent EOD reports ─────────────────────────
router.get("/eod-reports", async (req, res) => {
  const limit = parseInt(req.query.limit || "7");
  let q = supabase
    .from("eod_reports")
    .select("*")
    .order("date", { ascending: false })
    .limit(limit);
  if (req.orgId) q = q.eq("org_id", req.orgId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/agents/suggestions — improvement suggestions ─────────────────────
router.get("/suggestions", async (req, res) => {
  let q = supabase
    .from("improvement_suggestions")
    .select("*")
    .is("actioned_at", null)
    .order("priority")
    .order("created_at", { ascending: false })
    .limit(20);
  if (req.orgId) q = q.eq("org_id", req.orgId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/agents/language-profiles — language profiles (global, no org scope) ──
router.get("/language-profiles", async (req, res) => {
  const { data, error } = await supabase
    .from("language_profiles")
    .select("*")
    .order("state")
    .order("city");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/agents/call-queue — Sophia dialer queue ─────────────────────────
router.get("/call-queue", async (req, res) => {
  let q = supabase
    .from("call_queue")
    .select("*, lead:lead_id(business_name, phone, city)")
    .eq("status", "pending")
    .order("priority")
    .order("created_at")
    .limit(50);
  if (req.orgId) q = q.eq("org_id", req.orgId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /api/agents/suggestions/:id/action — mark suggestion actioned ───────
router.patch("/suggestions/:id/action", async (req, res) => {
  const { id } = req.params;
  let q = supabase
    .from("improvement_suggestions")
    .update({ actioned_at: new Date().toISOString() })
    .eq("id", id);
  if (req.orgId) q = q.eq("org_id", req.orgId);
  const { error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /api/agents/:id/activate — approve + activate a proposed agent ───────
router.post("/:id/activate", async (req, res) => {
  const { id } = req.params;
  const performer = req.user?.email || "admin";

  const { data: agent, error: fetchErr } = await supabase
    .from("agent_registry")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !agent) return res.status(404).json({ error: "Agent not found" });
  if (agent.status === "active") return res.json({ ok: true, message: "Already active" });

  const { error: updateErr } = await supabase
    .from("agent_registry")
    .update({ status: "active", activated_at: new Date().toISOString() })
    .eq("id", id);

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await supabase.from("agent_audit_log").insert({
    agent_id:     id,
    action:       "activated",
    performed_by: performer,
    details:      { previous_status: agent.status },
  });

  res.json({ ok: true, agent: { ...agent, status: "active" } });
});

// ── POST /api/agents/:id/deactivate — deactivate an agent ────────────────────
router.post("/:id/deactivate", async (req, res) => {
  const { id } = req.params;
  const performer = req.user?.email || "admin";

  const { data: agent, error: fetchErr } = await supabase
    .from("agent_registry")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !agent) return res.status(404).json({ error: "Agent not found" });

  const { error: updateErr } = await supabase
    .from("agent_registry")
    .update({ status: "inactive" })
    .eq("id", id);

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await supabase.from("agent_audit_log").insert({
    agent_id:     id,
    action:       "deactivated",
    performed_by: performer,
    details:      { previous_status: agent.status },
  });

  res.json({ ok: true });
});

// ── POST /api/agents/:id/run — manually trigger an agent ─────────────────────
router.post("/:id/run", async (req, res) => {
  const { id } = req.params;
  const performer = req.user?.email || "admin";

  const { data: agent, error: fetchErr } = await supabase
    .from("agent_registry")
    .select("slug, status, name")
    .eq("id", id)
    .single();

  if (fetchErr || !agent) return res.status(404).json({ error: "Agent not found" });
  if (agent.status !== "active") return res.status(400).json({ error: "Agent is not active" });

  await supabase.from("agent_audit_log").insert({
    agent_id:     id,
    action:       "manual_run",
    performed_by: performer,
  });

  // Fire and forget — don't block the HTTP response
  setImmediate(async () => {
    try {
      const orgId = req.orgId || null;
      if (agent.slug === "queue-health") {
        const { runQueueHealth } = require("../lib/agents/queueHealth");
        await runQueueHealth(orgId);
      } else if (agent.slug === "lead-scout") {
        const { runLeadScout } = require("../lib/agents/leadScout");
        await runLeadScout({ orgId });
      } else if (agent.slug === "eod-report") {
        const { runEodReport } = require("../lib/agents/eodReport");
        await runEodReport(orgId);
      } else if (agent.slug === "appt-confirmation") {
        const { runAppointmentConfirmation } = require("../lib/agents/appointmentConfirmation");
        await runAppointmentConfirmation(orgId);
      } else if (agent.slug === "sms-followup") {
        const { runSmsFollowUp } = require("../lib/agents/smsFollowUp");
        await runSmsFollowUp(orgId);
      } else if (agent.slug === "review-request") {
        const { runReviewRequest } = require("../lib/agents/reviewRequest");
        await runReviewRequest(orgId);
      }
      await supabase.from("agent_audit_log").insert({
        agent_id: id, action: "run_complete", performed_by: "system",
      });
    } catch (e) {
      console.error(`[agents] Manual run failed for ${agent.slug}:`, e.message);
      await supabase.from("agent_audit_log").insert({
        agent_id: id, action: "run_error", performed_by: "system",
        details: { error: e.message },
      });
    }
  });

  res.json({ ok: true, message: `${agent.name} triggered` });
});

// ── GET/PATCH /api/agents/sophia-config — per-org Sophia dialer settings ─────
// Stored inside organizations.custom_wording._sophia (no migration needed)
router.get("/sophia-config", async (req, res) => {
  if (!req.orgId) return res.status(401).json({ error: "No org context" });
  const { data } = await supabase.from("organizations").select("custom_wording").eq("id", req.orgId).maybeSingle();
  const sophia = data?.custom_wording?._sophia || {};
  res.json({ auto_dial: sophia.auto_dial ?? false, language: sophia.language || "auto" });
});

router.patch("/sophia-config", async (req, res) => {
  if (!req.orgId) return res.status(401).json({ error: "No org context" });
  const { data: org } = await supabase.from("organizations").select("custom_wording").eq("id", req.orgId).maybeSingle();
  const current = org?.custom_wording || {};
  const updated = { ...current, _sophia: { ...(current._sophia || {}), ...req.body } };
  const { error } = await supabase.from("organizations").update({ custom_wording: updated }).eq("id", req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, ...(updated._sophia || {}) });
});

// ── POST /api/agents/language-profiles — upsert a profile ────────────────────
router.post("/language-profiles", async (req, res) => {
  const { area_code, language, timezone, region_name } = req.body;
  if (!area_code) return res.status(400).json({ error: "area_code required" });
  const { data, error } = await supabase
    .from("language_profiles")
    .upsert(
      { area_code: String(area_code), language: language || "en", timezone: timezone || "America/Los_Angeles", region_name: region_name || null },
      { onConflict: "area_code" }
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/agents/language-profiles/:area_code ────────────────────────────
router.delete("/language-profiles/:area_code", async (req, res) => {
  const { error } = await supabase.from("language_profiles").delete().eq("area_code", req.params.area_code);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

module.exports = router;

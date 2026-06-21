// routes/scoring.js — customizable lead scoring weights per org
const express  = require("express");
const axios    = require("axios");
const router   = express.Router();
const supabase = require("../db/supabase");
const { checkAndRecord } = require("../lib/usageMeter");

const DEFAULT_WEIGHTS = {
  has_phone:           20,
  has_email:           10,
  has_address:         10,
  has_owner_name:      10,
  recent_activity:     15,
  high_value_status:   20,
  notes_quality:       10,
  long_stale:         -15,
};

// GET /api/scoring/weights — get org's current scoring config
router.get("/weights", async (req, res) => {
  if (!req.orgId) return res.json({ weights: DEFAULT_WEIGHTS, fields: [] });
  try {
    const { data } = await supabase
      .from("scoring_weights")
      .select("*")
      .eq("org_id", req.orgId)
      .maybeSingle();

    res.json({
      weights: data?.weights || DEFAULT_WEIGHTS,
      fields:  data?.custom_fields || [],
      updated_at: data?.updated_at || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/scoring/weights — save org scoring config
router.put("/weights", async (req, res) => {
  if (!["admin","super_admin"].includes(req.role)) {
    return res.status(403).json({ error: "Admin only" });
  }
  const { weights, custom_fields } = req.body;
  if (!weights) return res.status(400).json({ error: "weights required" });

  try {
    const { data, error } = await supabase
      .from("scoring_weights")
      .upsert({
        org_id:        req.orgId,
        weights,
        custom_fields: custom_fields || [],
        updated_at:    new Date().toISOString(),
      }, { onConflict: "org_id" })
      .select()
      .single();
    if (error) throw error;
    res.json({ weights: data.weights, fields: data.custom_fields });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scoring/score-lead — score a single lead with current weights
router.post("/score-lead", async (req, res) => {
  const { lead } = req.body;
  if (!lead) return res.status(400).json({ error: "lead required" });

  try {
    const { data: weightData } = await supabase
      .from("scoring_weights")
      .select("weights")
      .eq("org_id", req.orgId)
      .maybeSingle();
    const weights = weightData?.weights || DEFAULT_WEIGHTS;

    const score = computeScore(lead, weights);
    res.json({ score, lead_id: lead.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scoring/apply-all — re-score all leads with current weights
router.post("/apply-all", async (req, res) => {
  if (!["admin","super_admin"].includes(req.role)) {
    return res.status(403).json({ error: "Admin only" });
  }
  if (!req.orgId) return res.status(401).json({ error: "No org context" });

  try {
    await checkAndRecord(req.orgId, "ai_message", { endpoint: "scoring-apply-all" });

    const [leadsRes, weightsRes] = await Promise.all([
      supabase.from("leads").select("*").eq("org_id", req.orgId).limit(500),
      supabase.from("scoring_weights").select("weights").eq("org_id", req.orgId).maybeSingle(),
    ]);

    const leads   = leadsRes.data   || [];
    const weights = weightsRes.data?.weights || DEFAULT_WEIGHTS;

    let updated = 0;
    const updates = leads.map(lead => ({
      id:             lead.id,
      priority_score: computeScore(lead, weights),
    }));

    for (const upd of updates) {
      await supabase.from("leads").update({ priority_score: upd.priority_score }).eq("id", upd.id);
      updated++;
    }

    res.json({ updated, total: leads.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scoring/ai-prioritize — use Claude to score leads (batch, more nuanced)
router.post("/ai-prioritize", async (req, res) => {
  const { lead_ids } = req.body;
  if (!Array.isArray(lead_ids) || !lead_ids.length) {
    return res.status(400).json({ error: "lead_ids array required" });
  }

  try {
    await checkAndRecord(req.orgId, "ai_message", { endpoint: "ai-prioritize" });

    const [leadsRes, orgRes] = await Promise.all([
      supabase.from("leads").select("id,business_name,business_type,city,status,notes,phone,owner_name,priority_score").in("id", lead_ids),
      supabase.from("organizations").select("industry_name,custom_wording").eq("id", req.orgId).single(),
    ]);

    const leads   = leadsRes.data  || [];
    const org     = orgRes.data    || {};
    const industry = org.industry_name || "Sales";
    const wording  = org.custom_wording || {};

    const aiRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system: `You are a ${industry} sales prioritization AI. Score each lead 1-10 for outreach priority. Consider completeness of info, status, business type, and opportunity signals. Return JSON array only.`,
        messages: [{
          role: "user",
          content: `Industry: ${industry}\nCustomer type: ${wording.customerPlural || "customers"}\n\nScore these ${wording.leadPlural || "leads"}:\n${JSON.stringify(leads)}\n\nReturn: [{ id, priorityScore (1-10), reason (1 sentence), bestTimeToReach }]`
        }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        timeout: 15000,
      }
    );

    const text   = aiRes.data?.content?.[0]?.text || "[]";
    const scored = JSON.parse(text.replace(/```json|```/g, "").trim());

    await Promise.all(scored.map(s =>
      supabase.from("leads").update({ priority_score: s.priorityScore }).eq("id", s.id)
    ));

    res.json({ scored, total: scored.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function computeScore(lead, weights) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  let score = 0;

  if (lead.phone)      score += w.has_phone || 0;
  if (lead.owner_email || lead.email) score += w.has_email || 0;
  if (lead.address)    score += w.has_address || 0;
  if (lead.owner_name) score += w.has_owner_name || 0;
  if (lead.notes && lead.notes.length > 20) score += w.notes_quality || 0;

  const highValueStatuses = ["Follow Up", "Qualified", "Proposal", "Hot"];
  if (highValueStatuses.includes(lead.status)) score += w.high_value_status || 0;

  const staleStatuses = ["Not Interested", "Lost", "Converted"];
  if (staleStatuses.includes(lead.status)) score += w.long_stale || 0;

  if (lead.updated_at) {
    const daysSinceUpdate = (Date.now() - new Date(lead.updated_at)) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate < 3) score += w.recent_activity || 0;
    if (daysSinceUpdate > 30) score += (w.long_stale || 0) * 0.5;
  }

  return Math.max(1, Math.min(10, Math.round(score / 10)));
}

module.exports = router;

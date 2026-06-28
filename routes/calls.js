// routes/calls.js — Bland.ai AI call trigger + call log storage
const express  = require("express");
const axios    = require("axios");
const router   = express.Router();
const supabase = require("../db/supabase");
const { checkAndRecord } = require("../lib/usageMeter");
const { buildCallScript } = require("../lib/callScript");
const { isWithinCallingWindow } = require("../lib/timezone");
const { ensureSophiaPathway } = require("../lib/blandPathway");

// POST /api/calls/trigger
// Body: { lead_id } — pulls lead data, builds script, fires call
router.post("/trigger", async (req, res) => {
  const { lead_id } = req.body;

  if (!lead_id) return res.status(400).json({ error: "lead_id is required" });
  const blandKey = process.env.BLAND_KEY || process.env.BLAND_API_KEY;
  if (!blandKey) return res.status(500).json({ error: "Bland.ai API key not configured" });

  try {
    // Get lead from database
    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .select(`*, reps(name, phone)`)
      .eq("id", lead_id)
      .single();

    if (leadErr || !lead) return res.status(404).json({ error: "Lead not found" });
    if (!lead.phone)      return res.status(400).json({ error: "Lead has no phone number" });

    // Cap check — throws 429 if over limit, 503 if meter unavailable
    await checkAndRecord(req.orgId, "call", { lead_id });

    // Format phone for Bland.ai — needs +1XXXXXXXXXX format
    const rawPhone = lead.phone.replace(/\D/g, "");
    const phone = rawPhone.startsWith("1") ? `+${rawPhone}` : `+1${rawPhone}`;

    const repName = lead.reps?.name || "our local specialist";

    const requestData = {
      businessName:    lead.business_name,
      ownerName:       lead.owner_name || "there",
      city:            lead.city || "",
      currentProvider: lead.current_provider || "your current provider",
      repName,
    };

    // Prefer pathway (proper branching) over flat task prompt
    const pathwayId = await ensureSophiaPathway();

    const language = req.body.language || "auto";

    const blandPayload = pathwayId
      ? {
          phone_number:           phone,
          pathway_id:             pathwayId,
          voice:                  "maya",
          max_duration:           12,
          wait_for_greeting:      true,
          record:                 true,
          interruption_threshold: 100,
          webhook: `${process.env.WEBHOOK_BASE_URL}/api/webhooks/bland`,
          metadata: { lead_id, business_name: lead.business_name, rep_name: repName },
          request_data:           requestData,
        }
      : {
          // Fallback: flat task prompt (no pathway)
          phone_number:           phone,
          task: buildCallScript({
            businessName:    lead.business_name,
            ownerName:       lead.owner_name,
            city:            lead.city,
            currentProvider: lead.current_provider,
            repName,
          }),
          model:                  "enhanced",
          language,
          voice:                  "maya",
          max_duration:           12,
          wait_for_greeting:      true,
          record:                 true,
          interruption_threshold: 100,
          temperature:            0.7,
          webhook: `${process.env.WEBHOOK_BASE_URL}/api/webhooks/bland`,
          metadata: { lead_id, business_name: lead.business_name, rep_name: repName },
          request_data:           requestData,
        };

    const blandRes = await axios.post(
      "https://us.api.bland.ai/v1/calls",
      blandPayload,
      {
        headers: { "Content-Type": "application/json", "authorization": blandKey },
        timeout: 30000,
      }
    );

    const callId = blandRes.data?.call_id;

    // Log the call in database
    const { error: logErr } = await supabase.from("call_logs").insert({
      lead_id,
      bland_call_id:  callId,
      phone_number:   lead.phone,
      business_name:  lead.business_name,
      owner_name:     lead.owner_name || null,
      rep_name:       repName,
      language:       language,
      status:         "initiated",
      org_id:         req.orgId || req.headers["x-org-id"] || null,
    });
    if (logErr) console.error("CALL_LOGS INSERT FAILED:", logErr.message, JSON.stringify(logErr));

    // Update lead status
    await supabase
      .from("leads")
      .update({ status: "Called" })
      .eq("id", lead_id);

    res.json({
      success:       true,
      call_id:       callId,
      phone_dialed:  lead.phone,
      business:      lead.business_name,
    });

  } catch (err) {
    if (err.status === 429 || err.status === 503 || err.status === 401) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Call trigger error:", err.message);
    console.error("Bland response:", JSON.stringify(err.response?.data));
    console.error("Key used (first 20):", blandKey?.slice(0, 20));
    res.status(500).json({ error: "Failed to trigger call", detail: err.message });
  }
});

// POST /api/calls/bulk-trigger
// Body: { lead_ids: [...], language? } — queue multiple real Bland.ai calls
router.post("/bulk-trigger", async (req, res) => {
  const { lead_ids, language = "auto" } = req.body;
  if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
    return res.status(400).json({ error: "lead_ids array required" });
  }
  if (lead_ids.length > 25) {
    return res.status(400).json({ error: "Max 25 calls per batch" });
  }

  const blandKey = process.env.BLAND_KEY || process.env.BLAND_API_KEY;
  if (!blandKey) return res.status(500).json({ error: "Bland.ai API key not configured" });

  const results = [];
  for (const lead_id of lead_ids) {
    try {
      const { data: lead, error: leadErr } = await supabase
        .from("leads")
        .select(`*, reps(name, phone)`)
        .eq("id", lead_id)
        .single();

      if (leadErr || !lead || !lead.phone) {
        results.push({ lead_id, status: "skipped", reason: leadErr ? leadErr.message : "no phone" });
        continue;
      }

      // Skip if outside the lead's calling window (respects territory hours + TZ)
      if (!isWithinCallingWindow(lead)) {
        results.push({ lead_id, status: "skipped", reason: "outside_calling_window" });
        continue;
      }

      await checkAndRecord(req.orgId, "call", { lead_id });

      const rawPhone = lead.phone.replace(/\D/g, "");
      const phone = rawPhone.startsWith("1") ? `+${rawPhone}` : `+1${rawPhone}`;
      const repName = lead.reps?.name || "our local specialist";

      const bulkRequestData = {
        businessName:    lead.business_name,
        ownerName:       lead.owner_name || "there",
        city:            lead.city || "",
        currentProvider: lead.current_provider || "your current provider",
        repName,
      };

      const bulkPathwayId = await ensureSophiaPathway();

      const bulkPayload = bulkPathwayId
        ? {
            phone_number: phone, pathway_id: bulkPathwayId,
            voice: "maya", max_duration: 12, wait_for_greeting: true,
            record: true, interruption_threshold: 100,
            webhook: `${process.env.WEBHOOK_BASE_URL}/api/webhooks/bland`,
            metadata: { lead_id, business_name: lead.business_name, rep_name: repName },
            request_data: bulkRequestData,
          }
        : {
            phone_number: phone,
            task: buildCallScript({ businessName: lead.business_name, ownerName: lead.owner_name, city: lead.city, currentProvider: lead.current_provider, repName }),
            model: "enhanced", language,
            voice: "maya", max_duration: 12, wait_for_greeting: true,
            record: true, interruption_threshold: 100, temperature: 0.7,
            webhook: `${process.env.WEBHOOK_BASE_URL}/api/webhooks/bland`,
            metadata: { lead_id, business_name: lead.business_name, rep_name: repName },
            request_data: bulkRequestData,
          };

      const blandRes = await axios.post(
        "https://us.api.bland.ai/v1/calls",
        bulkPayload,
        { headers: { "Content-Type": "application/json", authorization: blandKey }, timeout: 30000 }
      );

      const callId = blandRes.data?.call_id;
      await supabase.from("call_logs").insert({
        lead_id, bland_call_id: callId, phone_number: lead.phone,
        business_name: lead.business_name, rep_name: repName,
        language, status: "initiated", org_id: req.orgId || null,
      });
      await supabase.from("leads").update({ status: "Called" }).eq("id", lead_id);

      results.push({ lead_id, status: "triggered", call_id: callId });
    } catch (err) {
      results.push({ lead_id, status: "error", error: err.message });
    }

    // Stagger calls 3 seconds apart to avoid spam flags
    if (lead_ids.indexOf(lead_id) < lead_ids.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  res.json({ triggered: results.filter(r => r.status === "triggered").length, results });
});

// GET /api/calls/logs — call history
router.get("/logs", async (req, res) => {
  const { lead_id, limit = 50 } = req.query;
  try {
    let query = supabase
      .from("call_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(Number(limit));

    if (lead_id) query = query.eq("lead_id", lead_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ logs: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/calls/:bland_call_id — check call status from Bland.ai
router.get("/:bland_call_id", async (req, res) => {
  const blandKey = process.env.BLAND_KEY || process.env.BLAND_API_KEY;
  if (!blandKey) return res.status(500).json({ error: "Bland.ai API key not configured" });
  try {
    const blandRes = await axios.get(
      `https://us.api.bland.ai/v1/calls/${req.params.bland_call_id}`,
      { headers: { authorization: blandKey } }
    );
    res.json(blandRes.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

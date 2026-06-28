// routes/hiring.js — Vera hiring pipeline: applicant CRUD + phone screen + calendar OAuth
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");
const { makeOAuthClient, getOrgClients, SCOPES } = require("../lib/hiringCalendar");
const { PLATFORM_NAME } = require("../lib/brand");

// ── Applicants CRUD ───────────────────────────────────────────────────────────

router.get("/applicants", async (req, res) => {
  const { data, error } = await supabase
    .from("applicants")
    .select("*")
    .eq("org_id", req.orgId)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post("/applicants", async (req, res) => {
  const { name, phone, email, position, notes } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const { data, error } = await supabase
    .from("applicants")
    .insert({ org_id: req.orgId, name, phone, email, position: position || "Sales Rep", notes })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get("/applicants/:id", async (req, res) => {
  const { data, error } = await supabase
    .from("applicants")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.orgId)
    .maybeSingle();
  if (!data) return res.status(404).json({ error: "Not found" });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put("/applicants/:id", async (req, res) => {
  const allowed = ["name","phone","email","position","status","notes","interview_at","offer_sent_at","hired_at"];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("applicants")
    .update(updates)
    .eq("id", req.params.id)
    .eq("org_id", req.orgId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete("/applicants/:id", async (req, res) => {
  const { error } = await supabase
    .from("applicants")
    .delete()
    .eq("id", req.params.id)
    .eq("org_id", req.orgId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

// POST /api/hiring/applicants/:id/screen — trigger Bland.ai phone screen
router.post("/applicants/:id/screen", async (req, res) => {
  const { data: applicant } = await supabase
    .from("applicants")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.orgId)
    .maybeSingle();

  if (!applicant)       return res.status(404).json({ error: "Applicant not found" });
  if (!applicant.phone) return res.status(400).json({ error: "Applicant has no phone number" });
  if (!process.env.BLAND_KEY) return res.status(500).json({ error: "BLAND_KEY not configured" });

  try {
    const axios = require("axios");
    const backendUrl = process.env.BACKEND_URL || "https://salesplatform-backend.railway.app";
    const webhookUrl = `${backendUrl}/api/webhooks/bland-hiring?secret=${process.env.BLAND_WEBHOOK_SECRET}`;

    const callRes = await axios.post(
      "https://us.api.bland.ai/v1/calls",
      {
        phone_number: applicant.phone,
        task: `You are a friendly hiring assistant for ${PLATFORM_NAME}. You are calling ${applicant.name} about the Sales Representative position they applied for. Keep the call under 5 minutes. Ask: 1) Can you tell me about your sales experience? 2) Why are you interested in a sales role with us? 3) Are you comfortable making outbound calls and working on commission? 4) What is your availability — can you start within the next 2 weeks? After the questions, tell them you will be in touch with next steps. Be warm and professional.`,
        voice: "maya",
        language: "en",
        model: "turbo",
        webhook: webhookUrl,
        metadata: { applicant_id: applicant.id, org_id: req.orgId, applicant_name: applicant.name },
        max_duration: 8,
        record: true,
      },
      { headers: { authorization: process.env.BLAND_KEY } }
    );

    const callId = callRes.data.call_id;
    await supabase
      .from("applicants")
      .update({ status: "screening", bland_call_id: callId, updated_at: new Date().toISOString() })
      .eq("id", applicant.id);

    res.json({ call_id: callId, status: "screening" });
  } catch (err) {
    console.error("[hiring] screen trigger failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Google Calendar OAuth ─────────────────────────────────────────────────────

// GET /api/hiring/google/connect — returns OAuth URL
router.get("/google/connect", (req, res) => {
  const auth = makeOAuthClient();
  const url  = auth.generateAuthUrl({
    access_type: "offline",
    prompt:      "consent",
    scope:       SCOPES,
    state:       req.orgId,
  });
  res.json({ url });
});

// GET /api/hiring/google/callback — OAuth redirect (public, org_id from state param)
router.get("/google/callback", async (req, res) => {
  const { code, state: orgId, error } = req.query;
  const frontend = process.env.FRONTEND_URL || "http://localhost:3000";

  if (error || !code || !orgId) {
    return res.redirect(`${frontend}/?hiring_gcal=denied`);
  }

  try {
    const auth = makeOAuthClient();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    const { google } = require("googleapis");
    const oauth2 = google.oauth2({ version: "v2", auth });
    let email = null;
    try { email = (await oauth2.userinfo.get()).data.email || null; } catch (_) {}

    if (!tokens.refresh_token) {
      return res.redirect(`${frontend}/?hiring_gcal=norefresh`);
    }

    await supabase.from("org_calendar_tokens").upsert(
      { org_id: orgId, refresh_token: tokens.refresh_token, email, connected_at: new Date().toISOString() },
      { onConflict: "org_id" }
    );

    res.redirect(`${frontend}/?hiring_gcal=connected`);
  } catch (e) {
    console.error("[hiring gcal] callback failed:", e.message);
    res.redirect(`${frontend}/?hiring_gcal=error`);
  }
});

// GET /api/hiring/google/status
router.get("/google/status", async (req, res) => {
  const { data } = await supabase
    .from("org_calendar_tokens")
    .select("email, connected_at")
    .eq("org_id", req.orgId)
    .maybeSingle();
  res.json({ connected: !!data, email: data?.email || null });
});

// DELETE /api/hiring/google/disconnect
router.delete("/google/disconnect", async (req, res) => {
  await supabase.from("org_calendar_tokens").delete().eq("org_id", req.orgId);
  res.json({ disconnected: true });
});

module.exports = router;

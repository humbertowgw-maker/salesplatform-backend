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

// POST /api/hiring/applicants/:id/send-offer — generate + deliver offer letter
router.post("/applicants/:id/send-offer", async (req, res) => {
  const { data: applicant } = await supabase
    .from("applicants")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.orgId)
    .maybeSingle();

  if (!applicant) return res.status(404).json({ error: "Applicant not found" });

  const { data: org } = await supabase
    .from("organizations").select("name").eq("id", req.orgId).maybeSingle();
  const orgName = org?.name || PLATFORM_NAME;

  // Generate offer letter via Claude
  let offerLetter;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{
          role: "user",
          content: `Write a brief, warm offer letter for a ${applicant.position || "Sales Representative"} position at ${orgName}. Candidate name: ${applicant.name}. Under 180 words. Start with "Dear ${applicant.name.split(" ")[0]}," and end with "${orgName} Hiring Team". Professional, no salary details.`,
        }],
      });
      offerLetter = msg.content[0]?.text || null;
    } catch (e) {
      console.warn("[hiring] Claude offer letter failed:", e.message);
    }
  }

  if (!offerLetter) {
    const firstName = applicant.name.split(" ")[0];
    offerLetter = `Dear ${firstName},\n\nCongratulations! We are thrilled to offer you the ${applicant.position || "Sales Representative"} position at ${orgName}.\n\nYour skills and enthusiasm impressed our team throughout the interview process, and we believe you'll be a valuable addition.\n\nPlease reply to confirm your acceptance and we will send you onboarding details.\n\nWe look forward to welcoming you aboard!\n\nBest regards,\n${orgName} Hiring Team`;
  }

  // Update applicant record
  await supabase
    .from("applicants")
    .update({ status: "offered", offer_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", applicant.id);

  // Send SMS
  if (applicant.phone) {
    try {
      const { sendSms } = require("../lib/sms");
      const firstName = applicant.name.split(" ")[0];
      await sendSms({
        toPhone: applicant.phone,
        body: `Hi ${firstName}! Great news — ${orgName} is excited to offer you the ${applicant.position || "Sales Rep"} position. Check your email for your offer letter. We look forward to hearing from you!`,
        source: "hiring",
      });
    } catch (e) { console.warn("[hiring] Offer SMS failed:", e.message); }
  }

  // Send email via Gmail (hiring calendar token)
  let emailSent = false;
  if (applicant.email) {
    try {
      const { getOrgClients, sendOfferEmail } = require("../lib/hiringCalendar");
      const clients = await getOrgClients(req.orgId);
      if (clients?.gmail) {
        await sendOfferEmail(clients.gmail, { toEmail: applicant.email, applicantName: applicant.name, orgName, offerLetter });
        emailSent = true;
      }
    } catch (e) { console.warn("[hiring] Offer email failed:", e.message); }
  }

  res.json({ success: true, offer_sent: true, email_sent: emailSent });
});

// POST /api/hiring/applicants/:id/hire — create rep profile + send Supabase invite
router.post("/applicants/:id/hire", async (req, res) => {
  const { data: applicant } = await supabase
    .from("applicants")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.orgId)
    .maybeSingle();

  if (!applicant) return res.status(404).json({ error: "Applicant not found" });

  let userId = null;

  // Invite user to platform via Supabase
  if (applicant.email) {
    try {
      const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
        applicant.email,
        { data: { org_id: req.orgId, role: "rep" } }
      );
      if (inviteErr) console.warn("[hiring] Supabase invite failed:", inviteErr.message);
      else userId = inviteData?.user?.id || null;
    } catch (e) { console.warn("[hiring] Invite error:", e.message); }
  }

  // Create user_roles entry
  if (applicant.email) {
    const roleRecord = { email: applicant.email, role: "rep", org_id: req.orgId };
    if (userId) roleRecord.user_id = userId;
    const { error: roleErr } = await supabase.from("user_roles").insert(roleRecord);
    if (roleErr) console.warn("[hiring] user_roles insert failed:", roleErr.message);
  }

  // Create reps entry
  const { data: repData, error: repErr } = await supabase
    .from("reps")
    .insert({ name: applicant.name, email: applicant.email || null, phone: applicant.phone || null, color: "#6366f1" })
    .select()
    .single();
  if (repErr) console.warn("[hiring] reps insert failed:", repErr.message);

  // Mark applicant as hired
  await supabase
    .from("applicants")
    .update({ status: "hired", hired_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", applicant.id);

  res.json({ success: true, hired: true, rep_id: repData?.id || null, invite_sent: !!userId });
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

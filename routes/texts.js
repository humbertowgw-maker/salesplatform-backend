// routes/texts.js — Twilio SMS outreach + AI response handling
const express = require("express");
const router  = express.Router();
const supabase = require("../db/supabase");
const axios   = require("axios");
const { checkAndRecord } = require("../lib/usageMeter");

// Lazy-load Twilio so missing credentials don't crash the whole server
function getTwilio() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured");
  }
  const twilio = require("twilio");
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// POST /api/texts/send — send outbound text to a lead
router.post("/send", async (req, res) => {
  const { lead_id, message } = req.body;

  if (!lead_id) return res.status(400).json({ error: "lead_id is required" });

  try {
    const { data: lead } = await supabase
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .single();

    if (!lead?.phone) return res.status(400).json({ error: "Lead has no phone number" });

    // Cap check — throws 429 if over limit, 503 if meter unavailable
    await checkAndRecord(req.orgId, "sms", { lead_id });

    const rawPhone = lead.phone.replace(/\D/g, "");
    const phone = rawPhone.startsWith("1") ? `+${rawPhone}` : `+1${rawPhone}`;

    const body = message || buildFirstText({
      businessName:    lead.business_name,
      ownerName:       lead.owner_name,
      city:            lead.city,
      currentProvider: lead.current_provider,
    });

    const client = getTwilio();
    const msg = await client.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   phone,
    });

    // Log the text
    await supabase.from("text_logs").insert({
      lead_id,
      twilio_sid: msg.sid,
      direction:  "outbound",
      body,
      phone_from: process.env.TWILIO_PHONE_NUMBER,
      phone_to:   lead.phone,
      status:     msg.status,
    });

    // Update lead status
    if (lead.status === "New" || lead.status === "No Answer") {
      await supabase.from("leads").update({ status: "Texted" }).eq("id", lead_id);
    }

    res.json({ success: true, twilio_sid: msg.sid, message_sent: body });

  } catch (err) {
    if (err.status === 429 || err.status === 503 || err.status === 401) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Text send error:", err.message);
    res.status(500).json({ error: "Failed to send text", detail: err.message });
  }
});

// POST /api/webhooks/twilio/inbound — receives inbound replies
// (Wire this up in your Twilio console: Messaging → Phone Numbers → Webhook URL)
router.post("/inbound", async (req, res) => {
  const { From, Body, To } = req.body;

  try {
    // Find the lead by phone number
    const { data: lead } = await supabase
      .from("leads")
      .select("*")
      .eq("phone", From)
      .maybeSingle();

    // Log the inbound message
    await supabase.from("text_logs").insert({
      lead_id:    lead?.id || null,
      direction:  "inbound",
      body:       Body,
      phone_from: From,
      phone_to:   To,
      status:     "received",
    });

    // Get conversation history for AI reply
    const { data: history } = await supabase
      .from("text_logs")
      .select("direction, body, created_at")
      .eq("lead_id", lead?.id)
      .order("created_at", { ascending: true })
      .limit(10);

    // Generate AI reply
    const aiReply = await generateAIReply({
      inboundMessage: Body,
      lead,
      history: history || [],
    });

    if (aiReply) {
      const client = getTwilio();
      const msg = await client.messages.create({
        body: aiReply,
        from: To,
        to:   From,
      });

      await supabase.from("text_logs").insert({
        lead_id:    lead?.id || null,
        direction:  "outbound",
        body:       aiReply,
        phone_from: To,
        phone_to:   From,
        status:     msg.status,
      });
    }

    // Return empty TwiML response (Twilio requires this)
    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);

  } catch (err) {
    console.error("Inbound text error:", err.message);
    res.set("Content-Type", "text/xml");
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }
});

// GET /api/texts/logs — text history
router.get("/logs", async (req, res) => {
  const { lead_id, limit = 50 } = req.query;
  try {
    let query = supabase
      .from("text_logs")
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

// ── MESSAGE TEMPLATES ─────────────────────────────────────────────────────────
function buildFirstText({ businessName, ownerName, city, currentProvider }) {
  const name     = ownerName ? ownerName.split(" ")[0] : "there";
  const provider = currentProvider ? `your ${currentProvider} service` : "your current wireless setup";
  return `Hi ${name}! This is Sofia with White Glove Wireless — we partner with AT&T to help small businesses in ${city} save on their internet and wireless. We tried calling ${businessName} and missed you. Worth a quick 15-min visit from our local rep to see what's available? Reply YES and we'll get something on the calendar. Reply STOP to opt out.`;
}

async function generateAIReply({ inboundMessage, lead, history }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const msg = inboundMessage.toLowerCase().trim();

  // Instant opt-out — never reply after STOP
  if (msg === "stop" || msg === "unsubscribe" || msg === "quit") return null;

  try {
    const conversationHistory = history.map(h => ({
      role:    h.direction === "outbound" ? "assistant" : "user",
      content: h.body,
    }));
    conversationHistory.push({ role: "user", content: inboundMessage });

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model:      "claude-sonnet-4-6",
        max_tokens: 200,
        system:     `You are Sofia, a friendly outreach rep for White Glove Wireless (AT&T partner). You're texting with ${lead?.owner_name || "a business owner"} at ${lead?.business_name || "their business"} in ${lead?.city || "Washington"}. Your goal is to book an in-person appointment with their local AT&T rep Monday–Saturday. Keep replies SHORT (1–2 sentences max). Be warm, natural, never pushy. If they want to book, confirm a day and time. If they say no or ask to stop, thank them and end the conversation.`,
        messages:   conversationHistory,
      },
      {
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        timeout: 10000,
      }
    );

    return res.data?.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.warn("AI reply failed:", e.message);
    return null;
  }
}

module.exports = router;

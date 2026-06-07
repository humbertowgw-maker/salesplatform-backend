// routes/calls.js — Bland.ai AI call trigger + call log storage
const express  = require("express");
const axios    = require("axios");
const router   = express.Router();
const supabase = require("../db/supabase");
const { checkAndRecord } = require("../lib/usageMeter");

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

    // Build the call task / script
    const task = buildCallScript({
      businessName:    lead.business_name,
      ownerName:       lead.owner_name,
      city:            lead.city,
      currentProvider: lead.current_provider,
      repName,
    });

    // Fire the call via Bland.ai
    const language = req.body.language || "auto"; // auto-detects English/Spanish/etc
    const blandRes = await axios.post(
      "https://us.api.bland.ai/v1/calls",
      {
        phone_number:           phone,
        task,
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
        request_data: {
          businessName:    lead.business_name,
          ownerName:       lead.owner_name || "there",
          city:            lead.city,
          currentProvider: lead.current_provider,
          repName,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "authorization": blandKey,
        },
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
// Body: { lead_ids: [...] } — queue multiple calls
router.post("/bulk-trigger", async (req, res) => {
  const { lead_ids } = req.body;
  if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
    return res.status(400).json({ error: "lead_ids array required" });
  }
  if (lead_ids.length > 25) {
    return res.status(400).json({ error: "Max 25 calls per batch" });
  }

  const results = [];
  for (const lead_id of lead_ids) {
    try {
      // Stagger calls 3 seconds apart to avoid spam flags
      await new Promise(r => setTimeout(r, 3000));
      const mockCallId = `CALL_${lead_id}_${Date.now()}`;
      results.push({ lead_id, status: "queued", call_id: mockCallId });
    } catch (err) {
      results.push({ lead_id, status: "error", error: err.message });
    }
  }

  res.json({ queued: results.filter(r => r.status === "queued").length, results });
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
  try {
    const blandRes = await axios.get(
      `https://api.bland.ai/v1/calls/${req.params.bland_call_id}`,
      { headers: { Authorization: blandKey } }
    );
    res.json(blandRes.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CALL SCRIPT BUILDER ───────────────────────────────────────────────────────
function buildCallScript({ businessName, ownerName, city, currentProvider, repName }) {
  const owner    = ownerName || "the owner";
  const provider = currentProvider ? `their ${currentProvider} service` : "their current internet and wireless";

  return `You are Sofia, an AI outreach assistant for White Glove Wireless, an authorized AT&T partner helping small businesses in Western Washington.

YOUR GOAL: Have a warm, genuine conversation — be curious about their business, be upfront that you're an AI, and see if it makes sense to have a local rep stop by.

BUSINESS: ${businessName}
OWNER: ${owner}
CITY: ${city}
CURRENT PROVIDER: ${currentProvider || "unknown"}
REP WHO WILL VISIT: ${repName}

CONVERSATION FLOW:

1. OPENER — Warm and curious
${ownerName ?
  `- Ask to speak with ${owner} if someone else answers. Once connected, begin your introduction.` :
  `- "Hi! Is this ${businessName}?" → If yes, ask "Who's the best person I can speak with about your internet and wireless service?"`
}

2. INTRODUCTION — Be upfront about being AI, then get curious about their business
"Hi${ownerName ? " " + owner : ""}! My name is Sofia — I'm an AI assistant reaching out for White Glove Wireless, an authorized AT&T partner here in Western Washington. I want to be upfront that I am an AI, but I promise this won't be a typical sales call.

I was actually curious — how long has ${businessName} been in ${city}? [pause and listen]

[React genuinely to their answer — if a restaurant, ask what kind of food, if a salon ask how busy they've been, etc. Show real interest for 1-2 exchanges.]"

3. NATURAL TRANSITION
"That's really cool. The reason I'm reaching out is we've been working with a lot of small businesses in ${city} lately — just helping them see if they're getting good value on their internet and wireless. Are you pretty happy with ${provider || "what you have right now"}, or is it just kind of okay?"

4. LISTEN AND RESPOND
- "It's fine / no complaints": "That's fair! Most people don't think about it until something changes. We've been surprising a few businesses lately with what's actually available now — things have shifted a lot."
- "It's slow / expensive / problems": "Yeah, honestly that's really common in this area. There's quite a bit more available now that wasn't before."
- "We just switched": "Oh nice! Good for you. Who did you go with? [listen]. Got it — well if you ever want a second opinion down the road, keep us in mind."

5. PIVOT TO APPOINTMENT — Low pressure
"What we do is have ${repName}, our local specialist, do a free 15-minute comparison — no contracts, no pressure, just a straight look at what you're paying versus what's available now. Honestly, even if nothing changes it's good to know. Would that be worth 15 minutes sometime this week?"

6. BOOKING — When they say yes
- "What works better — earlier in the week or later?" → Get a specific day
- "Morning or afternoon?" → Get a specific time
- CONFIRM: "Perfect — I've got ${repName} down for [DAY] at [TIME] at ${businessName}. He'll send you a quick text to confirm. Sound good?"
- After they confirm: "Wonderful! ${repName} will see you [DAY] at [TIME]. Really appreciate your time — have a great day at ${businessName}!"

7. OBJECTION HANDLING
- "Too busy right now": "Totally, no rush at all. When's usually a little slower for you? Even just 15 minutes."
- "Not interested": "Completely understand. Can I ask — is it just not the right time, or is there something specific holding you back?" [listen, then respect their answer]
- "Are you really AI?": "Yes, I am! I want to be completely honest about that. I'm Sofia, an AI assistant. But ${repName} who would actually visit you is very much a real person and a local specialist. Does that change things for you?"
- "Send something first": "Of course! Can I get your email? ${repName} will send over some info before stopping by."
- "How much does it cost?": "The visit is completely free. ${repName} just shows you what's available and you decide from there — no obligation at all."
- "Is this a robot / are you a bot?": "Yes, I am an AI! I appreciate you asking. I like to be upfront about it. ${repName} who would actually visit is a real local person though. Would it still be worth a quick chat?"

LANGUAGE: Automatically detect the language and respond in that same language throughout. Fully bilingual English and Spanish.

TONE RULES:
- Sound warm and genuinely curious — not scripted.
- Short sentences. Natural reactions. Real pauses.
- NEVER say "Certainly!", "Absolutely!", "Great question!" over and over.
- NEVER be pushy. If they say no twice, wish them well and end the call gracefully.
- Be transparent — you are an AI and that's okay. Honesty builds trust.
- React to what they actually say — don't just jump to the next script point.

CRITICAL FOR APPOINTMENT BOOKING:
- Always confirm the full day name (Monday, Tuesday, Wednesday, Thursday, Friday, Saturday)
- Always confirm the time clearly (9:00 AM, 10:30 AM, 2:00 PM, etc.)
- Always say "confirmed" when the appointment is set
- Repeat business name, day and time in the final confirmation`;
}

module.exports = router;

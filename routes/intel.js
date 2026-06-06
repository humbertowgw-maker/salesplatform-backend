// routes/intel.js — AI-powered lead prioritization + script generation + FCC intel
const express  = require("express");
const axios    = require("axios");
const router   = express.Router();
const supabase = require("../db/supabase");

// POST /api/intel/prioritize
router.post("/prioritize", async (req, res) => {
  const { lead_ids } = req.body;
  if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
    return res.status(400).json({ error: "lead_ids array required" });
  }
  try {
    const { data: leads } = await supabase
      .from("leads")
      .select("id, business_name, business_type, city, current_provider, estimated_lines")
      .in("id", lead_ids);
    if (!leads?.length) return res.status(404).json({ error: "No leads found" });
    const aiRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514", max_tokens: 1000,
        system: "B2B sales prioritization AI for AT&T. Score each lead 1-10 for outreach priority. Return JSON array only: [{ id, priorityScore, reason, estimatedLines, bestTimeToCall }]",
        messages: [{ role: "user", content: `Score these leads:\n${JSON.stringify(leads)}` }],
      },
      { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 15000 }
    );
    const text = aiRes.data?.content?.[0]?.text || "[]";
    const scored = JSON.parse(text.replace(/```json|```/g, "").trim());
    await Promise.all(scored.map(s => supabase.from("leads").update({ priority_score: s.priorityScore }).eq("id", s.id)));
    res.json({ scored, total: scored.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/intel/script
router.post("/script", async (req, res) => {
  const { businessType, currentProvider, city, painPoint } = req.body;
  try {
    const aiRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514", max_tokens: 800,
        system: "Write natural AT&T B2B cold call scripts. Return JSON only: { opener, bridge, pivot, objectionHandlers: { busy, happy, noInterest, costQuestion }, close }",
        messages: [{ role: "user", content: `Business: ${businessType}\nProvider: ${currentProvider}\nCity: ${city}\nPain point: ${painPoint}` }],
      },
      { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 12000 }
    );
    const text = aiRes.data?.content?.[0]?.text || "{}";
    res.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/intel/fcc — AI sales intel for FCC providers
router.post("/fcc", async (req, res) => {
  const { providers, address } = req.body;
  if (!providers?.length) return res.status(400).json({ error: "providers required" });
  try {
    const providerList = providers
      .map(p => `${p.brand_name}: ${p.technology_description}, ↓${p.max_advertised_download_speed}Mbps ↑${p.max_advertised_upload_speed}Mbps`)
      .join("\n");
    const aiRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514", max_tokens: 600,
        system: "AT&T B2B sales strategist. Return JSON only: { summary, talkingPoints: [3 strings], primaryCompetitor, angle, competitiveScore }",
        messages: [{ role: "user", content: `Address: ${address}\n\nProviders:\n${providerList}\n\nGive AT&T sales intel.` }],
      },
      { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 15000 }
    );
    const text = aiRes.data?.content?.[0]?.text || "{}";
    res.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// POST /api/intel/assistant — Multi-AI sales assistant with web search
router.post("/assistant", async (req, res) => {
  const { messages, lead, context } = req.body;

  const systemPrompt = `You are an expert AT&T B2B sales coach and market intelligence assistant for White Glove Wireless, an authorized AT&T dealer in Western Washington.

YOUR ROLE:
- Guide reps on how to approach specific business prospects
- Research current AT&T promotions and competitor pricing in real-time
- Ask targeted questions to understand the prospect better
- Suggest the best pitch angle based on the competitor they use
- Help close sales by providing specific, verified talking points

CURRENT LEAD CONTEXT:
${lead ? `
- Business: ${lead.business_name || "Unknown"}
- City: ${lead.city || "Unknown"}, WA  
- Phone Type: ${lead.phone_type || "Unknown"}
- Current Internet: ${lead.current_provider || "Unknown"}
- Wireless Carrier: ${lead.wireless_carrier || "Unknown"}
- Status: ${lead.status || "New"}
- Call Attempts: ${lead.call_attempts || 0}
- Owner: ${lead.owner_name || "Unknown"}
` : "No specific lead selected — giving general guidance"}

PLATFORM TOOLS AVAILABLE:
- Lead Search: Find businesses by type and city (Google Places, 60 results)
- FCC Broadband Intelligence: Look up all ISPs at any address nationwide
- AI Calls: Sofia calls businesses automatically in English or Spanish
- SMS Outreach: Text follow-ups
- Calendar: Auto-books appointments
- Call Logs: Track all call outcomes
- Lead Enrichment: Auto-detect phone type and owner info

BEHAVIOR:
- Be conversational and ask 1-2 targeted questions to better understand the situation
- Use web search to find current AT&T promotions and competitor pricing
- Always give specific, actionable advice — not generic tips
- When you find pricing data, cite it specifically ("Xfinity currently charges $X for Y Mbps")
- Suggest the best AT&T product to lead with based on the competitor
- Help with objection handling specific to their current provider`;

  try {
    // Run Claude (with web search) + Groq in parallel
    const [claudeResult, groqResult] = await Promise.allSettled([
      // Claude with web search for live data
      axios.post(
        "https://api.anthropic.com/v1/messages",
        {
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: systemPrompt,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: messages || [],
        },
        {
          headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          timeout: 30000,
        }
      ),
    ]);

    let responseText = "";

    if (claudeResult.status === "fulfilled") {
      const content = claudeResult.value.data?.content || [];
      responseText = content.filter(b => b.type === "text").map(b => b.text).join("");
    }

    if (!responseText) {
      responseText = "I'm having trouble connecting to live data right now. Let me give you my best guidance based on what I know about AT&T and your market.";
    }

    res.json({ response: responseText, sources: claudeResult.status === "fulfilled" ? ["Claude + Web Search"] : [] });

  } catch (err) {
    console.error("Assistant error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// routes/news.js — AI-powered market intelligence + talk tracks
// Industry-agnostic: uses org's industry_name and custom wording to generate relevant content
const express = require("express");
const axios   = require("axios");
const router  = express.Router();
const supabase = require("../db/supabase");
const { checkAndRecord } = require("../lib/usageMeter");
const { AI_AGENT_NAME } = require("../lib/brand");

async function askClaude(system, userMsg, maxTokens = 800) {
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMsg }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      timeout: 20000,
    }
  );
  return res.data?.content?.[0]?.text || "";
}

async function getOrgConfig(orgId) {
  if (!orgId) return {};
  const { data } = await supabase.from("organizations").select("industry_key,industry_name,custom_wording,pipeline_stages").eq("id", orgId).single();
  return data || {};
}

// POST /api/news/generate-insight — generate AI insight from a topic + org industry
router.post("/generate-insight", async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: "topic required" });

  try {
    await checkAndRecord(req.orgId, "ai_message", { endpoint: "news-insight" });
    const org = await getOrgConfig(req.orgId);
    const industry = org.industry_name || "Sales";
    const wording  = org.custom_wording || {};

    const text = await askClaude(
      `You are a market intelligence analyst for a ${industry} company. Generate actionable sales insights from news topics.`,
      `Topic: "${topic}"\nIndustry: ${industry}\nCustomer type: ${wording.customerPlural || "customers"}\n\nReturn a concise market insight (2-3 paragraphs) with: 1) what this means for the industry, 2) how sales reps can use this, 3) a specific talk track or conversation starter. Be specific and practical.`,
      600
    );

    res.json({ insight: text, topic, industry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/news/talk-track — generate talk track for reps
router.post("/talk-track", async (req, res) => {
  const { topic, context } = req.body;
  if (!topic) return res.status(400).json({ error: "topic required" });

  try {
    await checkAndRecord(req.orgId, "ai_message", { endpoint: "news-talk-track" });
    const org = await getOrgConfig(req.orgId);
    const industry    = org.industry_name || "Sales";
    const wording     = org.custom_wording || {};
    const repLabel    = wording.repSingular || "rep";
    const customerLbl = wording.customerSingular || "customer";

    const text = await askClaude(
      `You are a ${industry} sales coach. Write concise, natural-sounding talk tracks that reps can actually use on calls.`,
      `Topic/news item: "${topic}"\n${context ? `Additional context: ${context}\n` : ""}Industry: ${industry}\nRep title: ${repLabel}\nCustomer type: ${customerLbl}\n\nWrite a talk track with:\n- OPENER: How to bring this up naturally\n- KEY POINT: The core value message (1-2 sentences)\n- QUESTION: A discovery question to get them talking\n- RESPONSE (if interested): Next step\n- RESPONSE (if not interested): Graceful exit\n\nKeep it conversational, not scripted-sounding.`,
      500
    );

    res.json({ talk_track: text, topic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/news/digest — AI daily sales digest based on industry + topics
router.post("/digest", async (req, res) => {
  const { topics } = req.body; // optional array of custom topics

  try {
    await checkAndRecord(req.orgId, "ai_message", { endpoint: "news-digest" });
    const org = await getOrgConfig(req.orgId);
    const industry = org.industry_name || "Sales";
    const wording  = org.custom_wording || {};
    const stages   = (org.pipeline_stages || []).join(", ");

    const topicList = topics?.length
      ? topics.map((t, i) => `${i + 1}. ${t}`).join("\n")
      : `General ${industry} market trends, industry news, competitive landscape, regulatory changes, technology updates`;

    const text = await askClaude(
      `You are a ${industry} sales intelligence system. Generate a concise, actionable daily briefing for a sales team.`,
      `Industry: ${industry}\nPipeline stages: ${stages}\nCustomer type: ${wording.customerPlural || "customers"}\nRep title: ${wording.repPlural || "reps"}\n\nTopics to cover:\n${topicList}\n\nGenerate a morning sales digest with:\n- 3-5 BULLET POINTS: Key market signals relevant to today's sales conversations\n- FOCUS OF THE DAY: One specific action reps should take today\n- CONVERSATION STARTER: An opening line related to current market conditions\n\nBe specific, brief, and actionable. No fluff.`,
      700
    );

    res.json({ digest: text, industry, generated_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/news/objection-response — AI-generated objection handler
router.post("/objection-response", async (req, res) => {
  const { objection } = req.body;
  if (!objection) return res.status(400).json({ error: "objection required" });

  try {
    await checkAndRecord(req.orgId, "ai_message", { endpoint: "news-objection" });
    const org = await getOrgConfig(req.orgId);
    const industry    = org.industry_name || "Sales";
    const wording     = org.custom_wording || {};
    const customerLbl = wording.customerSingular || "customer";

    const text = await askClaude(
      `You are a ${industry} sales coach who specializes in handling objections gracefully.`,
      `Industry: ${industry}\nCustomer type: ${customerLbl}\nObjection: "${objection}"\n\nProvide:\n1. ACKNOWLEDGE: Validate their concern (1 sentence)\n2. REFRAME: Shift the perspective (1-2 sentences)\n3. RESPONSE: Your actual reply (2-3 sentences max)\n4. FOLLOW-UP QUESTION: Keep the conversation alive\n\nTone: Warm, confident, not pushy.`,
      400
    );

    res.json({ response: text, objection });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/news/social-post — generate social media post from topic
router.post("/social-post", async (req, res) => {
  const { topic, platform = "LinkedIn" } = req.body;
  if (!topic) return res.status(400).json({ error: "topic required" });

  try {
    await checkAndRecord(req.orgId, "ai_message", { endpoint: "news-social" });
    const org = await getOrgConfig(req.orgId);
    const industry = org.industry_name || "Sales";

    const text = await askClaude(
      `You are a ${industry} industry thought leader who writes engaging ${platform} posts.`,
      `Topic: "${topic}"\nIndustry: ${industry}\nPlatform: ${platform}\n\nWrite a ${platform} post that:\n- Starts with a hook (not "I" as the first word)\n- Shares a genuine insight related to the topic\n- Has a clear call to action or question\n- Uses appropriate formatting for ${platform}\n- Is under 300 words\n\nDo NOT use excessive hashtags or generic business jargon.`,
      350
    );

    res.json({ post: text, platform, topic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/news/topics — get saved news topics for the org
router.get("/topics", async (req, res) => {
  if (!req.orgId) return res.json({ topics: [] });
  try {
    const { data } = await supabase
      .from("organizations")
      .select("news_topics")
      .eq("id", req.orgId)
      .single();
    res.json({ topics: data?.news_topics || [] });
  } catch (e) { res.json({ topics: [] }); }
});

// PUT /api/news/topics — save news topics for org
router.put("/topics", async (req, res) => {
  const { topics } = req.body;
  if (!req.orgId || !["admin","super_admin"].includes(req.role)) {
    return res.status(403).json({ error: "Admin only" });
  }
  try {
    const { error } = await supabase
      .from("organizations")
      .update({ news_topics: topics || [] })
      .eq("id", req.orgId);
    if (error) throw error;
    res.json({ success: true, topics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

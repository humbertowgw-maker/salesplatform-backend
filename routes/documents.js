// routes/documents.js — generalized document intake + Claude AI analysis
// Use for: contracts, invoices, competitor quotes, applications, intake forms, etc.
const express  = require("express");
const axios    = require("axios");
const router   = express.Router();
const supabase = require("../db/supabase");
const { checkAndRecord } = require("../lib/usageMeter");

async function analyzeWithClaude({ content, documentType, industry, customerType, instructions }) {
  const systemPrompt = `You are an intelligent document analyzer for a ${industry || "sales"} company. Extract key information and provide actionable insights for the sales team.`;

  const userPrompt = `Document type: ${documentType || "unknown"}
Customer type: ${customerType || "customer"}
${instructions ? `Special instructions: ${instructions}` : ""}

Document content:
${content}

Return a JSON object with:
{
  "summary": "2-3 sentence summary of what this document is",
  "key_data": { "field": "value" for the most important fields found },
  "action_items": ["array of actionable next steps for the sales team"],
  "signals": ["array of buying signals or pain points identified"],
  "risk_flags": ["array of any concerns or red flags"],
  "opportunity_score": 1-10
}`;

  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      timeout: 30000,
    }
  );

  const text = res.data?.content?.[0]?.text || "{}";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// POST /api/documents/analyze — submit document text for AI analysis
router.post("/analyze", async (req, res) => {
  const { content, document_type, lead_id, name, instructions } = req.body;
  if (!content) return res.status(400).json({ error: "content required" });

  try {
    await checkAndRecord(req.orgId, "ai_message", { endpoint: "doc-analyze" });

    const orgRes = await supabase
      .from("organizations")
      .select("industry_name,custom_wording")
      .eq("id", req.orgId)
      .maybeSingle();

    const org         = orgRes.data || {};
    const industry    = org.industry_name || "Sales";
    const customerType = org.custom_wording?.customerSingular || "customer";

    const analysis = await analyzeWithClaude({
      content,
      documentType: document_type,
      industry,
      customerType,
      instructions,
    });

    const { data, error } = await supabase
      .from("documents")
      .insert({
        org_id:        req.orgId,
        lead_id:       lead_id || null,
        name:          name || document_type || "Document",
        document_type: document_type || "general",
        content_text:  content.slice(0, 10000),
        analysis,
        status:        "analyzed",
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ document: data, analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/documents/analyze-image — analyze a document via base64 image (Claude vision)
router.post("/analyze-image", async (req, res) => {
  const { image_base64, media_type = "image/jpeg", document_type, lead_id, name, instructions } = req.body;
  if (!image_base64) return res.status(400).json({ error: "image_base64 required" });

  try {
    await checkAndRecord(req.orgId, "ai_message", { endpoint: "doc-analyze-image" });

    const orgRes = await supabase
      .from("organizations")
      .select("industry_name,custom_wording")
      .eq("id", req.orgId)
      .maybeSingle();

    const org          = orgRes.data || {};
    const industry     = org.industry_name || "Sales";
    const customerType = org.custom_wording?.customerSingular || "customer";

    const systemPrompt = `You are an intelligent document analyzer for a ${industry} company. Extract key information from this document image and provide actionable insights for the sales team.`;

    const aiRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type, data: image_base64 },
            },
            {
              type: "text",
              text: `Document type: ${document_type || "unknown"}\nCustomer type: ${customerType}\n${instructions ? `Instructions: ${instructions}\n` : ""}\nAnalyze this document and return JSON:\n{"summary":"...","key_data":{},"action_items":[],"signals":[],"risk_flags":[],"opportunity_score":1-10}`,
            },
          ],
        }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        timeout: 30000,
      }
    );

    const text     = aiRes.data?.content?.[0]?.text || "{}";
    const analysis = JSON.parse(text.replace(/```json|```/g, "").trim());

    const { data, error } = await supabase
      .from("documents")
      .insert({
        org_id:        req.orgId,
        lead_id:       lead_id || null,
        name:          name || document_type || "Document",
        document_type: document_type || "image",
        analysis,
        status:        "analyzed",
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ document: data, analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/documents — list org documents
router.get("/", async (req, res) => {
  const { lead_id, document_type, limit = 50 } = req.query;
  if (!req.orgId) return res.status(401).json({ error: "No org context" });

  try {
    let query = supabase
      .from("documents")
      .select("id,name,document_type,status,lead_id,analysis,created_at")
      .eq("org_id", req.orgId)
      .order("created_at", { ascending: false })
      .limit(parseInt(limit));

    if (lead_id)       query = query.eq("lead_id", lead_id);
    if (document_type) query = query.eq("document_type", document_type);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ documents: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/documents/:id
router.get("/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", req.params.id)
      .eq("org_id", req.orgId)
      .single();
    if (error) throw error;
    res.json({ document: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/documents/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", req.params.id)
      .eq("org_id", req.orgId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

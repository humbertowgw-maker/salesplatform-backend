const express = require("express");
const axios   = require("axios");
const router  = express.Router();
const { tryLocalFirst } = require("../lib/aiProviders");

router.post("/lookup", async (req, res) => {
  const { street, city, state = "WA", zip } = req.body;
  if (!city || !zip) return res.status(400).json({ error: "city and zip required" });
  const fullAddress = `${street ? street + ", " : ""}${city}, ${state} ${zip}`;
  try {
    // ISP-by-region coaching removed for vertical-neutral white-label.
    // Candidate for per-org config (Phase 2): orgs could supply their own
    // "include these ISPs" hints to tune results for their market.
    const ispSystem = `You are a broadband market expert with comprehensive knowledge of ISP coverage across all 50 US states. Given a city, state, and ZIP code, list ALL ISPs that realistically serve that area. Return JSON only: {"providers":[{"brand_name":"string","technology_description":"string","technology_code":number,"max_advertised_download_speed":number,"max_advertised_upload_speed":number,"low_latency":boolean}]}. Tech codes: 50=Fiber,40=Cable HFC,71=Licensed Fixed Wireless,62=Starlink,60=Satellite GSO,10=DSL.`;
    const ispPrompt = `ISPs for: ${fullAddress}, ${state} ${zip}`;
    const text = await tryLocalFirst({ system: ispSystem, prompt: ispPrompt, maxTokens: 900, timeoutMs: 30000 }, async () => {
      const aiRes = await axios.post(
        "https://api.anthropic.com/v1/messages",
        { model: "claude-sonnet-4-6", max_tokens: 900, system: ispSystem, messages: [{ role: "user", content: ispPrompt }] },
        { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 30000 }
      );
      return aiRes.data?.content?.[0]?.text || "{}";
    });
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    const providers = parsed.providers || [];
    let salesIntel = null;
    if (providers.length > 0) {
      const providerList = providers.map(p => `${p.brand_name}: ${p.technology_description}, down ${p.max_advertised_download_speed}Mbps`).join("\n");
      const intelSystem = "B2B sales strategist. Return JSON only: { summary, talkingPoints: [3 strings], primaryCompetitor, angle, competitiveScore }";
      const intelPrompt = `Address: ${fullAddress}\nProviders:\n${providerList}\nGive B2B competitive sales intel.`;
      const intelText = await tryLocalFirst({ system: intelSystem, prompt: intelPrompt, maxTokens: 500, timeoutMs: 15000 }, async () => {
        const intelRes = await axios.post("https://api.anthropic.com/v1/messages",
          { model: "claude-sonnet-4-6", max_tokens: 500, system: intelSystem, messages: [{ role: "user", content: intelPrompt }] },
          { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 15000 }
        );
        return intelRes.data?.content?.[0]?.text || "{}";
      });
      salesIntel = JSON.parse(intelText.replace(/```json|```/g,"").trim() || "{}");
    }
    res.json({ matched_address: fullAddress, providers, provider_count: providers.length, sales_intel: salesIntel, source: "AI" });
  } catch (err) {
    console.error("FCC lookup error:", err.message);
    res.status(500).json({ error: "Lookup failed", detail: err.message });
  }
});

router.post("/geocode", async (req, res) => { const { street, city, state = "WA", zip } = req.body; res.json({ lat: null, lng: null, matchedAddress: `${street}, ${city}, ${state} ${zip}` }); });
router.post("/locations", async (req, res) => res.json({ data: [] }));
router.post("/availability", async (req, res) => res.json({ data: [] }));

module.exports = router;

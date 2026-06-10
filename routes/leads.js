// routes/leads.js — Full CRUD for lead pipeline
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

// GET /api/leads — list all leads (with rep + territory join)
router.get("/", async (req, res) => {
  const { status, rep_id, territory_id, limit = 100, offset = 0 } = req.query;
  try {
    let query = supabase
      .from("lead_pipeline")   // uses the view we created in schema.sql
      .select("*")
      .order("created_at", { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status)       query = query.eq("status", status);
    if (rep_id)       query = query.eq("rep_id", rep_id);
    if (territory_id) query = query.eq("territory_id", territory_id);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ leads: data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/:id — single lead
router.get("/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("lead_pipeline")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Lead not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads — create a lead
router.post("/", async (req, res) => {
  const {
    business_name, business_type, owner_name, owner_email,
    phone, address, city, state, zip, current_provider,
    rep_id, territory_id, source, notes, priority_score,
  } = req.body;

  if (!business_name) {
    return res.status(400).json({ error: "business_name is required" });
  }

  try {
    const { data, error } = await supabase
      .from("leads")
      .insert({
        business_name, business_type, owner_name, owner_email,
        phone, address, city, state: state || "WA", zip,
        current_provider, rep_id, territory_id,
        source: source || ["Manual"],
        notes, priority_score,
        status: "New",
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/bulk — import multiple leads at once
router.post("/bulk", async (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: "leads array is required" });
  }

  try {
    const rows = leads.map(l => ({
      ...l,
      state:  l.state || "WA",
      status: l.status || "New",
      source: l.source || ["Import"],
    }));

    const { data, error } = await supabase
      .from("leads")
      .insert(rows)
      .select();

    if (error) throw error;
    res.status(201).json({ inserted: data.length, leads: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id — update a lead (status, rep assignment, notes, etc.)
router.patch("/:id", async (req, res) => {
  const allowed = [
    "status", "rep_id", "territory_id", "owner_name", "owner_email",
    "phone", "current_provider", "wireless_carrier", "notes", "priority_score",
    "fcc_checked", "fcc_providers", "phone_type", "linkedin_url", "owner_title", "website",
  ];
  const updates = {};
  allowed.forEach(key => {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  });

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  try {
    const { data, error } = await supabase
      .from("leads")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id
router.delete("/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("leads")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/enrich/:id — lookup owner + phone type
// POST /api/leads/enrich/:id — lookup owner + phone type
router.post("/enrich/:id", async (req, res) => {
  const axios = require("axios");
  try {
    const { data: lead } = await supabase.from("leads").select("*").eq("id", req.params.id).single();
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const updates = {};

    // Phone type — heuristic based on WA area codes
    if (lead.phone) {
      const rawPhone = lead.phone.replace(/\D/g, "");
      const areaCode = rawPhone.startsWith("1") ? rawPhone.slice(1, 4) : rawPhone.slice(0, 3);
      updates.phone_type = ["206","253","360","425","509","564"].includes(areaCode) ? "mobile" : "landline";
    }

    // Owner lookup via Google Places details
    if (!lead.owner_name && lead.google_place_id && process.env.GOOGLE_PLACES_API_KEY) {
      try {
        const placeRes = await axios.get(
          `https://places.googleapis.com/v1/places/${lead.google_place_id}`,
          {
            headers: {
              "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
              "X-Goog-FieldMask": "displayName,websiteUri,nationalPhoneNumber",
            },
            timeout: 8000,
          }
        );
        // Google Places doesn't give owner names directly
        // But we can get the website to try to find contact info
        const website = placeRes.data?.websiteUri;
        if (website) updates.website = website;
      } catch(e) {}
    }

    // ── Apollo.io People Match ────────────────────────────────────────────────
    // Uses credits — only call if we're missing email or owner
    if (process.env.APOLLO_API_KEY && (!lead.owner_email || !lead.owner_name)) {
      try {
        const apolloBody = { organization_name: lead.business_name };
        // Split owner name into first/last if we have one
        if (lead.owner_name) {
          const parts = lead.owner_name.trim().split(/\s+/);
          apolloBody.first_name = parts[0];
          if (parts.length > 1) apolloBody.last_name = parts.slice(1).join(" ");
        }
        // Try to extract domain from website if stored
        if (lead.website) {
          try { apolloBody.domain = new URL(lead.website).hostname.replace(/^www\./, ""); } catch(_) {}
        }

        const apolloRes = await axios.post(
          "https://api.apollo.io/api/v1/people/match",
          apolloBody,
          {
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${process.env.APOLLO_API_KEY}`,
            },
            timeout: 12000,
          }
        );

        const person = apolloRes.data?.person;
        if (person) {
          if (!lead.owner_name && person.name) updates.owner_name = person.name;
          if (!lead.owner_email && person.email) updates.owner_email = person.email;
          if (person.linkedin_url) updates.linkedin_url = person.linkedin_url;
          if (person.title && !updates.owner_title) updates.owner_title = person.title;
          // First mobile phone from Apollo
          const mobilePhone = person.phone_numbers?.find(p => p.type === "mobile")?.sanitized_number;
          if (mobilePhone && !lead.phone) {
            updates.phone = mobilePhone;
            updates.phone_type = "mobile";
          }
          console.log(`[enrich] Apollo matched: ${person.name} <${person.email}>`);
        }
      } catch (e) {
        // 422 = no match found (normal), 429 = rate limited
        if (e.response?.status !== 422) console.warn("[enrich] Apollo error:", e.message);
      }
    }

    // Owner lookup via AI knowledge (no web search needed for common WA restaurants)
    if (!lead.owner_name && !updates.owner_name && process.env.ANTHROPIC_API_KEY) {
      try {
        const aiRes = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: "claude-sonnet-4-6",
            max_tokens: 150,
            system: "You are a business intelligence assistant with knowledge of Washington State businesses. Given a business name and address, return the owner's name if you know it with confidence. Return JSON only: { owner_name, confidence } where confidence is low/medium/high. Only return medium or high if you are genuinely confident. Otherwise return { owner_name: null, confidence: 'low' }. Do not guess.",
            messages: [{ role: "user", content: `Business: ${lead.business_name}\nAddress: ${lead.address || ''}\nCity: ${lead.city || ''}, WA\nPhone: ${lead.phone || ''}` }],
          },
          { headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, timeout: 15000 }
        );
        const text = aiRes.data?.content?.[0]?.text || "{}";
        try {
          const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
          if (parsed.owner_name && parsed.confidence !== "low") {
            updates.owner_name = parsed.owner_name;
          }
        } catch(pe) {}
      } catch (e) { console.warn("Owner lookup failed:", e.message); }
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from("leads").update(updates).eq("id", req.params.id);
    }

    res.json({ enriched: updates, lead_id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

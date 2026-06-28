// lib/agents/leadScout.js — Lead Scout Agent
// Discovers new business leads via Google Places API and inserts them as leads.

const axios    = require("axios");
const supabase = require("../../db/supabase");

const PLACES_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json";
const DETAIL_URL = "https://maps.googleapis.com/maps/api/place/details/json";

// Default search targets — can be overridden via agent config
const DEFAULT_QUERIES = [
  "small businesses",
  "restaurants",
  "retail stores",
  "professional services",
  "auto shops",
];

async function runLeadScout({ orgId = null, location = null, queries = null, maxPerQuery = 10 } = {}) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn("[lead-scout] No Google Places API key set — skipping");
    return { skipped: true, reason: "No GOOGLE_PLACES_API_KEY set" };
  }

  const searchLocation = location || process.env.SCOUT_DEFAULT_LOCATION || "Seattle, WA";
  const searchQueries  = queries  || DEFAULT_QUERIES;

  let discovered = 0, inserted = 0, duplicates = 0;

  for (const q of searchQueries) {
    try {
      const { data: placesRes } = await axios.get(PLACES_URL, {
        params: { query: `${q} near ${searchLocation}`, key: apiKey },
        timeout: 10000,
      });

      const places = (placesRes.results || []).slice(0, maxPerQuery);
      discovered += places.length;

      for (const place of places) {
        // Skip if phone/name already in leads
        const name = place.name;
        const { count } = await supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .ilike("business_name", name);

        if (count > 0) { duplicates++; continue; }

        // Fetch phone number from Place Details
        let phone = null;
        try {
          const { data: detailRes } = await axios.get(DETAIL_URL, {
            params: { place_id: place.place_id, fields: "formatted_phone_number,website", key: apiKey },
            timeout: 8000,
          });
          phone = detailRes.result?.formatted_phone_number || null;
        } catch (_) {}

        const addressParts = (place.formatted_address || "").split(",");
        const city  = (addressParts[1] || "").trim();
        const state = (addressParts[2] || "").trim().split(" ")[0] || "WA";

        const row = {
          business_name: name,
          business_type: place.types?.[0]?.replace(/_/g, " ") || "Business",
          address:       addressParts[0]?.trim(),
          city,
          state,
          phone,
          source:        ["Lead Scout"],
          status:        "New",
          priority_score: place.rating ? Math.round(place.rating * 10) : 50,
        };
        if (orgId) row.org_id = orgId;

        const { error: insertErr } = await supabase.from("leads").insert(row);
        if (!insertErr) inserted++;
      }
    } catch (e) {
      console.error(`[lead-scout] Query "${q}" failed:`, e.message);
    }
  }

  // Stamp agent last run
  await supabase
    .from("agent_registry")
    .update({ last_run_at: new Date().toISOString(), run_count: supabase.raw("run_count + 1") })
    .eq("slug", "lead-scout");

  console.log(`[lead-scout] discovered=${discovered} inserted=${inserted} duplicates=${duplicates}`);
  return { discovered, inserted, duplicates };
}

module.exports = { runLeadScout };

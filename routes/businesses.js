// routes/businesses.js — Places API (New) with pagination for more results
const express = require("express");
const axios   = require("axios");
const router  = express.Router();

// POST /api/businesses/search
router.post("/search", async (req, res) => {
  const { keyword, city, state = "WA", radius = 10000, maxResults = 60 } = req.body;

  if (!keyword || !city) return res.status(400).json({ error: "keyword and city are required" });
  if (!process.env.GOOGLE_PLACES_API_KEY) return res.status(500).json({ error: "Google Places API key not configured" });

  try {
    const textQuery = `${keyword} in ${city}, ${state}`;
    let allPlaces = [];
    let nextPageToken = null;
    let pages = 0;
    const maxPages = Math.ceil(maxResults / 20);

    do {
      const body = {
        textQuery,
        maxResultCount: 20,
        locationBias: {
          circle: {
            center: { latitude: 47.9790, longitude: -122.2021 },
            radius,
          },
        },
      };
      if (nextPageToken) body.pageToken = nextPageToken;

      const placesRes = await axios.post(
        "https://places.googleapis.com/v1/places:searchText",
        body,
        {
          headers: {
            "Content-Type":    "application/json",
            "X-Goog-Api-Key":  process.env.GOOGLE_PLACES_API_KEY,
            "X-Goog-FieldMask": [
              "places.id",
              "places.displayName",
              "places.formattedAddress",
              "places.nationalPhoneNumber",
              "places.rating",
              "places.userRatingCount",
              "places.businessStatus",
              "places.types",
              "places.websiteUri",
              "places.regularOpeningHours",
              "places.primaryTypeDisplayName",
              "places.googleMapsUri",
              "nextPageToken",
            ].join(","),
          },
          timeout: 10000,
        }
      );

      const places = placesRes.data?.places || [];
      allPlaces = [...allPlaces, ...places];
      nextPageToken = placesRes.data?.nextPageToken || null;
      pages++;

      // Small delay between pages to avoid rate limiting
      if (nextPageToken && pages < maxPages) await new Promise(r => setTimeout(r, 500));

    } while (nextPageToken && pages < maxPages && allPlaces.length < maxResults);

    const businesses = allPlaces.map((p) => ({
      google_place_id: p.id,
      name:            p.displayName?.text || "Unknown",
      address:         p.formattedAddress || "",
      phone:           p.nationalPhoneNumber || null,
      rating:          p.rating || null,
      rating_count:    p.userRatingCount || null,
      website:         p.websiteUri || null,
      google_maps_url: p.googleMapsUri || null,
      business_type:   p.primaryTypeDisplayName?.text || (p.types?.[0] || ""),
      types:           p.types || [],
      business_status: p.businessStatus || "OPERATIONAL",
      hours:           p.regularOpeningHours?.weekdayDescriptions || null,
      hours_open_now:  p.regularOpeningHours?.openNow || null,
      source:          ["Google Places"],
      owner_name:      null,
      owner_email:     null,
      verified:        false,
    }));

    res.json({ businesses, total: businesses.length, query: textQuery });

  } catch (err) {
    console.error("Business search error:", err.response?.data || err.message);
    res.status(500).json({
      error: "Business search failed",
      detail: err.response?.data?.error?.message || err.message,
    });
  }
});

module.exports = router;


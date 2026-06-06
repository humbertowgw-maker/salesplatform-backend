// routes/google.js — per-rep Google Calendar OAuth (connect + callback)
const express = require("express");
const router = express.Router();
const supabase = require("../db/supabase");
const { makeOAuthClient } = require("../lib/googleCalendar");

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

router.get("/connect", (req, res) => {
  const { rep_id } = req.query;
  if (!rep_id) return res.status(400).json({ error: "rep_id is required" });

  const auth = makeOAuthClient();
  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: rep_id,
  });
  res.json({ url });
});

router.get("/callback", async (req, res) => {
  const { code, state: repId, error } = req.query;
  const frontend = process.env.FRONTEND_URL || "http://localhost:3000";

  if (error) return res.redirect(`${frontend}/?gcal=denied`);
  if (!code || !repId) return res.redirect(`${frontend}/?gcal=error`);

  try {
    const auth = makeOAuthClient();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    const { google } = require("googleapis");
    const oauth2 = google.oauth2({ version: "v2", auth });
    let email = null;
    try {
      const me = await oauth2.userinfo.get();
      email = me.data.email || null;
    } catch (_) {}

    if (!tokens.refresh_token) {
      return res.redirect(`${frontend}/?gcal=norefresh`);
    }

    await supabase.from("rep_google_tokens").upsert(
      {
        rep_id: repId,
        refresh_token: tokens.refresh_token,
        calendar_id: "primary",
        email,
        connected_at: new Date().toISOString(),
      },
      { onConflict: "rep_id" }
    );

    res.redirect(`${frontend}/?gcal=connected`);
  } catch (e) {
    console.error("[gcal] callback failed:", e.message);
    res.redirect(`${frontend}/?gcal=error`);
  }
});

router.get("/status", async (req, res) => {
  const { rep_id } = req.query;
  if (!rep_id) return res.status(400).json({ error: "rep_id is required" });
  const { data } = await supabase
    .from("rep_google_tokens")
    .select("email, connected_at")
    .eq("rep_id", rep_id)
    .maybeSingle();
  res.json({ connected: !!data, email: data?.email || null });
});

router.delete("/disconnect", async (req, res) => {
  const { rep_id } = req.query;
  if (!rep_id) return res.status(400).json({ error: "rep_id is required" });
  await supabase.from("rep_google_tokens").delete().eq("rep_id", rep_id);
  res.json({ disconnected: true });
});

module.exports = router;

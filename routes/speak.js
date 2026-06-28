// routes/speak.js
// MOUTH — turns AI text into natural OpenAI TTS audio (MP3).
// Protected by requireAuth because it spends OpenAI credits.
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");

router.post("/", requireAuth, async (req, res) => {
  const { text, voice = "onyx" } = req.body;
  if (!text) return res.status(400).json({ error: "No text" });
  try {
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice,
        response_format: "mp3",
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(500).json({ error: err });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

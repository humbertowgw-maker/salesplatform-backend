// lib/aiProviders.js — shared local-first AI helper for salesplatform-backend.
//
// No API key needed for Ollama — it's our own hardware (birdsStudio).
// Tried first on every text-generation call site; falls through to the
// caller's existing Claude/OpenAI logic unchanged on any failure/timeout.
// Never removes the paid path, only makes it secondary.

const OLLAMA_URL = process.env.OLLAMA_SALES_URL || "http://birdsstudio-1:11435";
const OLLAMA_MODEL = process.env.OLLAMA_SALES_MODEL || "qwen2.5:7b";

function ollamaEnabled() {
  return process.env.OLLAMA_SALES_ENABLED !== "false";
}

async function postChatCompletion(body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`local model HTTP ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty response");
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function tryLocalFirst({ system = "", prompt, messages, maxTokens = 1024, timeoutMs = 20000 }, fallbackFn) {
  if (ollamaEnabled()) {
    try {
      const chatMessages = messages
        ? [...(system ? [{ role: "system", content: system }] : []), ...messages]
        : [{ role: "system", content: system }, { role: "user", content: prompt }];
      return await postChatCompletion(
        { model: OLLAMA_MODEL, messages: chatMessages, max_tokens: maxTokens, temperature: 0.3 },
        timeoutMs
      );
    } catch {
      // fall through to fallbackFn below
    }
  }
  return fallbackFn();
}

const OLLAMA_VISION_MODEL = process.env.OLLAMA_SALES_VISION_MODEL || "qwen2.5vl:7b";

// Verified 2026-08-09 (spendsense, white-glove-social): Ollama's OpenAI-
// compatible endpoint needs OpenAI's own image_url/data-URI content shape,
// NOT Ollama's native `images` field — the native field silently no-ops
// through this endpoint, no error raised.
async function tryLocalFirstVision({ prompt, imageBase64, mediaType = "image/jpeg", maxTokens = 1000, timeoutMs = 60000 }, fallbackFn) {
  if (ollamaEnabled()) {
    try {
      return await postChatCompletion(
        {
          model: OLLAMA_VISION_MODEL,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
            ],
          }],
          max_tokens: maxTokens,
          temperature: 0.1,
        },
        timeoutMs
      );
    } catch {
      // fall through to fallbackFn below
    }
  }
  return fallbackFn();
}

module.exports = { tryLocalFirst, tryLocalFirstVision, ollamaEnabled };

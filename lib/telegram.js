// lib/telegram.js — Telegram Bot notification helper
const axios = require("axios");

function isConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

async function sendMessage(text) {
  if (!isConfigured()) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML" },
      { timeout: 8000 }
    );
  } catch (e) {
    console.warn("[telegram] send failed:", e.message);
  }
}

async function sendAppointmentBooked({ businessName, repName, day, time, city }) {
  await sendMessage(
    `📅 <b>APPOINTMENT BOOKED</b>\n\n` +
    `🏢 ${businessName}\n` +
    `👤 Rep: ${repName || "Unassigned"}\n` +
    `📍 ${city || "—"}\n` +
    `⏰ ${day} at ${time}`
  );
}

async function sendFollowupSummary({ triggered, skipped, errors }) {
  if (triggered === 0 && errors === 0) return;
  await sendMessage(
    `🔄 <b>FOLLOW-UP AUTOMATION RAN</b>\n\n` +
    `✅ Triggered: ${triggered} calls\n` +
    `⏭ Skipped: ${skipped}\n` +
    `❌ Errors: ${errors}`
  );
}

async function sendAlert(text) {
  await sendMessage(`🚨 <b>ALERT</b>\n\n${text}`);
}

module.exports = { sendMessage, sendAppointmentBooked, sendFollowupSummary, sendAlert, isConfigured };

// lib/sms.js — Shared Twilio SMS helper for agent-driven outreach
const supabase = require("../db/supabase");

function getTwilio() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured");
  }
  return require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function normalizePhone(raw = "") {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("1") ? `+${digits}` : `+1${digits}`;
}

// Send an SMS and log it to text_logs. Returns { sid } on success.
async function sendSms({ leadId, toPhone, body, orgId = null, source = "agent" }) {
  if (!toPhone) throw new Error("No phone number provided");
  if (!process.env.TWILIO_PHONE_NUMBER) throw new Error("TWILIO_PHONE_NUMBER not set");

  const client = getTwilio();
  const to     = normalizePhone(toPhone);

  const msg = await client.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });

  await supabase.from("text_logs").insert({
    lead_id:    leadId  || null,
    org_id:     orgId   || null,
    twilio_sid: msg.sid,
    direction:  "outbound",
    body,
    phone_from: process.env.TWILIO_PHONE_NUMBER,
    phone_to:   toPhone,
    status:     msg.status,
    source,
  });

  return { sid: msg.sid };
}

module.exports = { sendSms, normalizePhone };

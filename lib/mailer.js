// lib/mailer.js — outbound email with graceful degradation.
// Order: org Gmail OAuth (hiring calendar connection) → Resend API key → log-only.
const supabase = require("../db/supabase");
const { getOrgClients } = require("./hiringCalendar");

function textToHtml(text) {
  return `<!doctype html><html><body style="margin:0;background:#0b1120;padding:32px;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#111c33;border-radius:12px;border:1px solid #1e2d4a;overflow:hidden">
    <div style="background:#0a1428;padding:20px 28px;border-bottom:1px solid #1e2d4a">
      <span style="font-family:Georgia,serif;font-size:18px;font-weight:bold;color:#d4a373;letter-spacing:1px">WHITE GLOVE</span>
      <span style="font-size:10px;color:#6b7a99;letter-spacing:3px;margin-left:8px">WIRELESS</span>
    </div>
    <div style="padding:28px;color:#cbd5e1;font-size:14px;line-height:1.7">${text}</div>
    <div style="padding:16px 28px;border-top:1px solid #1e2d4a;font-size:10px;color:#475569">Sent by the WGW platform · do not reply directly to this email.</div>
  </div></div></body></html>`;
}

async function sendViaGmail(orgId, { to, subject, html }) {
  const clients = await getOrgClients(orgId);
  if (!clients?.gmail) return false;
  // Extract a From address from the connected token when possible
  let from;
  try {
    const about = await clients.gmail.users.getProfile({ userId: "me" });
    from = about.data.emailAddress;
  } catch (_) {}
  await clients.gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: Buffer.from(
        [`From: White Glove Wireless <${from || "notifications@whitegwireless.com"}>`,
         `To: ${to}`, `Subject: ${subject}`,
         "MIME-Version: 1.0",
         'Content-Type: text/html; charset="UTF-8"', "", html].join("\r\n")
      ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
    },
  });
  return true;
}

async function sendViaResend({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: process.env.MAIL_FROM || "White Glove Wireless <onboarding@resend.dev>", to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return true;
}

/**
 * sendMail({ orgId, to, subject, text })
 * Never throws — returns which channel delivered ("gmail" | "resend" | "logged").
 */
async function sendMail({ orgId, to, subject, text }) {
  const html = textToHtml(text);
  for (const [channel, fn] of [
    ["gmail", () => sendViaGmail(orgId, { to, subject, html })],
    ["resend", () => sendViaResend({ to, subject, html })],
  ]) {
    try {
      if (await fn()) return channel;
    } catch (e) {
      console.warn(`[mailer] ${channel} send failed:`, e.message);
    }
  }
  console.log(`[mailer] LOG-ONLY email to=${to} subject="${subject}"\n${text}`);
  return "logged";
}

/** Admin emails for an org (director + working admins). */
async function orgAdminEmails(orgId) {
  const { data } = await supabase
    .from("user_roles")
    .select("email")
    .eq("org_id", orgId)
    .in("role", ["admin", "super_admin"]);
  return [...new Set((data || []).map(r => r.email).filter(Boolean))];
}

/** In-app notification broadcast. */
async function notifyOrg(orgId, { title, body, type = "info", link = null, userEmail = null }) {
  await supabase.from("notifications").insert({ org_id: orgId, user_email: userEmail, title, body, type, link });
}

module.exports = { sendMail, orgAdminEmails, notifyOrg };

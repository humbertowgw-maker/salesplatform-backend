// lib/agents/smsFollowUp.js — SMS Follow-Up Agent
// Texts leads that didn't answer calls instead of ringing them again.
// Targets: No Answer / Voicemail with call_attempts >= 1, not recently texted.

const supabase = require("../../db/supabase");
const { sendSms } = require("../sms");

const SMS_COOLDOWN_HOURS = 48;
const BATCH_SIZE         = 20;
const MAX_CALL_ATTEMPTS  = 3;

function buildSmsMessage({ businessName, ownerName, city }) {
  const name = ownerName ? `${ownerName}` : "there";
  const loc  = city ? ` in ${city}` : "";
  return `Hi ${name}! We tried reaching ${businessName}${loc} about a special offer on business internet service. Would love to connect — reply back or visit our website to learn more. Reply STOP to opt out.`;
}

async function runSmsFollowUp(orgId = null) {
  const cooloff = new Date(Date.now() - SMS_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("leads")
    .select("id, business_name, owner_name, phone, city, call_attempts, status")
    .in("status", ["No Answer", "Voicemail"])
    .gte("call_attempts", 1)
    .lt("call_attempts", MAX_CALL_ATTEMPTS)
    .not("phone", "is", null)
    .limit(BATCH_SIZE);

  if (orgId) query = query.eq("org_id", orgId);

  const { data: leads, error } = await query;
  if (error) throw error;
  if (!leads?.length) {
    console.log("[sms-followup] No eligible leads");
    return { sent: 0, skipped: 0 };
  }

  let sent = 0, skipped = 0;

  for (const lead of leads) {
    // Skip if texted recently
    const { data: recentText } = await supabase
      .from("text_logs")
      .select("created_at")
      .eq("lead_id", lead.id)
      .eq("direction", "outbound")
      .gte("created_at", cooloff)
      .limit(1)
      .maybeSingle();

    if (recentText) { skipped++; continue; }

    const message = buildSmsMessage({
      businessName: lead.business_name,
      ownerName:    lead.owner_name,
      city:         lead.city,
    });

    try {
      await sendSms({
        leadId:  lead.id,
        toPhone: lead.phone,
        body:    message,
        orgId,
        source:  "sms-followup",
      });

      await supabase
        .from("leads")
        .update({ status: "Texted" })
        .eq("id", lead.id);

      sent++;
      console.log(`[sms-followup] Texted: ${lead.business_name}`);
    } catch (e) {
      console.error(`[sms-followup] Failed for ${lead.business_name}:`, e.message);
      skipped++;
    }
  }

  await supabase
    .from("agent_registry")
    .update({ last_run_at: new Date().toISOString(), run_count: supabase.raw("run_count + 1") })
    .eq("slug", "sms-followup");

  console.log(`[sms-followup] done — sent=${sent} skipped=${skipped}`);
  return { sent, skipped };
}

module.exports = { runSmsFollowUp };

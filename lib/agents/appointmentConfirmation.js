// lib/agents/appointmentConfirmation.js — Appointment Confirmation Agent
// Finds tomorrow's Pending appointments and sends a confirmation SMS to the lead.

const supabase = require("../../db/supabase");
const { sendSms } = require("../sms");

function buildConfirmationMessage({ businessName, ownerName, repName, day, time }) {
  const name = ownerName ? `, ${ownerName}` : "";
  return `Hi${name}! This is a reminder that ${repName || "our rep"} has an appointment scheduled with ${businessName} for ${day} at ${time}. Reply YES to confirm or STOP to cancel. We look forward to seeing you!`;
}

async function runAppointmentConfirmation(orgId = null) {
  // Tomorrow's date string (YYYY-MM-DD)
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let query = supabase
    .from("appointments")
    .select("id, lead_id, business_name, owner_name, scheduled_day, scheduled_time, scheduled_date, status, rep_id, reps(name)")
    .eq("status", "Pending");

  // Match by scheduled_date if set, otherwise scheduled_day text match
  query = query.or(`scheduled_date.eq.${tomorrow},scheduled_day.ilike.%${new Date(tomorrow + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long" })}%`);

  if (orgId) query = query.eq("org_id", orgId);

  const { data: appts, error } = await query;
  if (error) throw error;
  if (!appts?.length) {
    console.log("[appt-confirm] No pending appointments for tomorrow");
    return { sent: 0, skipped: 0 };
  }

  let sent = 0, skipped = 0;

  for (const appt of appts) {
    // Fetch lead phone
    if (!appt.lead_id) { skipped++; continue; }

    const { data: lead } = await supabase
      .from("leads")
      .select("phone, owner_name")
      .eq("id", appt.lead_id)
      .single();

    if (!lead?.phone) { skipped++; continue; }

    const message = buildConfirmationMessage({
      businessName: appt.business_name,
      ownerName:    appt.owner_name || lead.owner_name,
      repName:      appt.reps?.name,
      day:          appt.scheduled_day,
      time:         appt.scheduled_time,
    });

    try {
      await sendSms({
        leadId:  appt.lead_id,
        toPhone: lead.phone,
        body:    message,
        orgId,
        source:  "appt-confirmation",
      });

      // Mark appointment as confirmation sent
      await supabase
        .from("appointments")
        .update({ status: "Confirmed" })
        .eq("id", appt.id);

      sent++;
      console.log(`[appt-confirm] Confirmed: ${appt.business_name}`);
    } catch (e) {
      console.error(`[appt-confirm] Failed for ${appt.business_name}:`, e.message);
      skipped++;
    }
  }

  await supabase
    .from("agent_registry")
    .update({ last_run_at: new Date().toISOString(), run_count: supabase.raw("run_count + 1") })
    .eq("slug", "appt-confirmation");

  console.log(`[appt-confirm] done — sent=${sent} skipped=${skipped}`);
  return { sent, skipped };
}

module.exports = { runAppointmentConfirmation };

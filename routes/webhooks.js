// routes/webhooks.js — receives call results back from Bland.ai
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");
const telegram = require("../lib/telegram");

// Retry wrapper for transient Supabase failures
async function withRetry(fn, attempts = 3, delayMs = 1000) {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

// In-memory set to deduplicate rapid duplicate deliveries within the same process
const _recentlyProcessed = new Set();

// POST /api/webhooks/bland
// Bland.ai calls this URL after every completed call
router.post("/bland", async (req, res) => {
  const expectedSecret = process.env.BLAND_WEBHOOK_SECRET;
  if (!expectedSecret || req.query.secret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // Always respond 200 immediately — Bland.ai will retry if you don't
  res.status(200).json({ received: true });

  const payload = req.body;
  
  // Debug — log what Bland.ai actually sends
  console.log("🔵 Bland webhook received:", JSON.stringify({
    call_id: payload.call_id,
    status: payload.status,
    has_transcript: !!payload.transcript,
    has_concatenated: !!payload.concatenated_transcript,
    transcript_length: payload.transcript?.length || 0,
    concatenated_length: payload.concatenated_transcript?.length || 0,
    answered_by: payload.answered_by,
    keys: Object.keys(payload),
  }));

  const {
    call_id,
    status,
    transcript,
    concatenated_transcript,
    recording_url,
    cost,
    metadata,
    appointment: rawAppt,
  } = payload;

  // Bland sends duration as corrected_duration (seconds) or call_length (minutes) — not "duration"
  const duration = payload.corrected_duration
    ? Number(payload.corrected_duration)
    : payload.call_length
      ? Math.round(Number(payload.call_length) * 60)
      : 0;

  if (!call_id) return; // Malformed webhook

  // ── Idempotency: skip duplicate deliveries ────────────────────────────────
  if (_recentlyProcessed.has(call_id)) {
    console.log(`[webhook] ${call_id} already processing — skipped duplicate`);
    return;
  }
  _recentlyProcessed.add(call_id);
  setTimeout(() => _recentlyProcessed.delete(call_id), 5 * 60 * 1000); // expire after 5 min

  // Check DB-level idempotency: if outcome already recorded, skip fully
  const { data: existingLog } = await supabase
    .from("call_logs").select("id, outcome").eq("bland_call_id", call_id).maybeSingle();
  if (existingLog?.outcome) {
    console.log(`[webhook] ${call_id} already processed (outcome=${existingLog.outcome}) — skipped`);
    return;
  }

  const lead_id = metadata?.lead_id;

  try {
    // ── 1. Determine call outcome ─────────────────────────────────────────────
    const answeredBy = payload.answered_by || "unknown";
    
    // If transcript is missing, fetch directly from Bland.ai
    let finalTranscript = concatenated_transcript || transcript || null;
    let finalRecordingUrl = recording_url || null;
    
    if (!finalTranscript && call_id && process.env.BLAND_KEY) {
      try {
        const axios = require("axios");
        const blandRes = await axios.get(`https://us.api.bland.ai/v1/calls/${call_id}`, {
          headers: { authorization: process.env.BLAND_KEY },
          timeout: 10000,
        });
        finalTranscript = blandRes.data?.concatenated_transcript || blandRes.data?.transcript || null;
        finalRecordingUrl = finalRecordingUrl || blandRes.data?.recording_url || null;
        console.log("✅ Fetched transcript from Bland.ai API, length:", finalTranscript?.length || 0);
      } catch (fetchErr) {
        console.warn("Could not fetch transcript from Bland.ai:", fetchErr.message);
      }
    }
    
    const outcome = detectOutcome(status, finalTranscript || "", answeredBy, duration || 0);

    // ── 2. Update call log (with retry) ──────────────────────────────────────
    await withRetry(() =>
      supabase.from("call_logs").update({
        status:           status || "completed",
        duration_seconds: Math.round(duration || 0),
        transcript:       finalTranscript,
        outcome,
        recording_url:    finalRecordingUrl,
        cost_usd:         cost || null,
        answered_by:      answeredBy,
      }).eq("bland_call_id", call_id)
    );

    // ── 3. Update lead status + call attempt count (with retry) ──────────────
    if (lead_id) {
      // Get current call count
      const { data: lead } = await supabase.from("leads").select("call_attempts, call_count, owner_name").eq("id", lead_id).single();
      const callAttempts = (lead?.call_attempts || 0) + 1;
      const callCount = (lead?.call_count || 0) + 1;

      let newStatus = "Called";
      if (outcome === "no_answer")           newStatus = "No Answer";
      if (outcome === "voicemail")           newStatus = "Voicemail";
      if (outcome === "hung_up")             newStatus = "Hung Up";
      if (outcome === "not_interested")      newStatus = "Not Interested";
      if (outcome === "callback_requested")  newStatus = "Follow Up";
      if (outcome === "appointment_booked")  newStatus = "Appt Set";

      await withRetry(() =>
        supabase.from("leads")
          .update({ status: newStatus, call_attempts: callAttempts, call_count: callCount })
          .eq("id", lead_id)
      );
    }

    // ── 4. Auto-create appointment if one was booked ──────────────────────────
    if (outcome === "appointment_booked" && lead_id) {
      const apptDetails = extractAppointmentDetails(finalTranscript || "");

      if (apptDetails) {
        // Get lead + rep info
        const { data: lead } = await supabase
          .from("leads")
          .select(`*, reps(name, phone)`)
          .eq("id", lead_id)
          .single();

        await supabase.from("appointments").insert({
          lead_id,
          rep_id:         lead?.rep_id || null,
          business_name:  lead?.business_name || metadata?.business_name,
          owner_name:     lead?.owner_name,
          address:        lead?.address,
          scheduled_day:  apptDetails.day,
          scheduled_time: apptDetails.time,
          territory:      lead?.territory_id || null,
          booked_by:      "AI",
          status:         "Pending",
          notes:          `Booked by AI call on ${new Date().toLocaleDateString()}. Call ID: ${call_id}`,
        });

        console.log(`✅ Auto-booked appointment for ${metadata?.business_name}`);

        // Telegram notification
        telegram.sendAppointmentBooked({
          businessName: lead?.business_name || metadata?.business_name,
          repName:      lead?.reps?.name || metadata?.rep_name || "Unassigned",
          day:          apptDetails.day,
          time:         apptDetails.time,
          city:         lead?.city,
        });

        // ── Send confirmation text ────────────────────────────────────────────
        if (lead?.phone && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
          try {
            const twilio = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            const rawPhone = lead.phone.replace(/\D/g, "");
            const toPhone = rawPhone.startsWith("1") ? `+${rawPhone}` : `+1${rawPhone}`;
            const repName = lead.reps?.name || "our local specialist";
            const ownerName = lead.owner_name ? lead.owner_name.split(" ")[0] : "there";

            const { AI_AGENT_NAME } = require("../lib/brand");
            const confirmMsg = `Hi ${ownerName}! This is ${AI_AGENT_NAME} confirming your appointment with ${repName} on ${apptDetails.day} at ${apptDetails.time} at ${lead.business_name}. Reply YES to confirm, RESCHEDULE to pick a new time, or STOP to cancel. Looking forward to it!`;

            await twilio.messages.create({
              body: confirmMsg,
              from: process.env.TWILIO_PHONE_NUMBER,
              to: toPhone,
            });

            console.log(`✅ Confirmation text sent to ${lead.phone}`);
          } catch (smsErr) {
            console.warn("Confirmation SMS failed:", smsErr.message);
          }
        }
      }
    }

  } catch (err) {
    console.error("Bland webhook processing error:", err.message);
  }
});

// ── HELPERS ───────────────────────────────────────────────────────────────────

function detectOutcome(status, transcript, answeredBy, duration) {
  // No answer / voicemail
  if (status === "no-answer")                        return "no_answer";
  if (status === "voicemail")                        return "voicemail";
  if (answeredBy === "voicemail")                    return "voicemail";
  if (answeredBy === "no-answer")                    return "no_answer";

  const t = transcript.toLowerCase();

  // Very short call = hung up or not interested in AI
  if (duration < 15 && answeredBy === "human")       return "hung_up";

  // Appointment booked
  if (
    t.includes("confirmed") || t.includes("see you") ||
    t.includes("that works") || t.includes("sounds good") ||
    t.includes("looking forward") || t.includes("locked in") ||
    t.includes("we're all set") || t.includes("i'll be there") ||
    // Spanish
    t.includes("confirmado") || t.includes("nos vemos") ||
    t.includes("de acuerdo") || t.includes("hasta")
  ) return "appointment_booked";

  // Not interested
  if (
    t.includes("not interested") || t.includes("no thank you") ||
    t.includes("no thanks") || t.includes("don't call") ||
    t.includes("remove me") || t.includes("stop calling") ||
    t.includes("do not call") || t.includes("take me off") ||
    // Spanish
    t.includes("no me interesa") || t.includes("no gracias") ||
    t.includes("no llame")
  ) return "not_interested";

  // Hung up / detected AI
  if (
    t.includes("is this a robot") || t.includes("is this ai") ||
    t.includes("are you a robot") || t.includes("are you real") ||
    t.includes("i can tell this is") || t.includes("automated") ||
    t.includes("not talking to a machine") || t.includes("esta es una")
  ) return "hung_up";

  // Callback requested
  if (
    t.includes("send info") || t.includes("email me") ||
    t.includes("call back") || t.includes("call me back") ||
    t.includes("try again") || t.includes("better time") ||
    t.includes("call later") || t.includes("not a good time") ||
    // Spanish
    t.includes("llame después") || t.includes("mándeme")
  ) return "callback_requested";

  return "completed";
}

function extractAppointmentDetails(transcript) {
  const dayMap = {
    "monday": "Mon", "tuesday": "Tue", "wednesday": "Wed",
    "thursday": "Thu", "friday": "Fri", "saturday": "Sat", "sunday": "Sun"
  };
  const timePatterns = [
    "9:00 am", "9:30 am", "10:00 am", "10:30 am", "11:00 am", "11:30 am",
    "12:00 pm", "12:30 pm", "1:00 pm", "1:30 pm", "2:00 pm", "2:30 pm",
    "3:00 pm", "3:30 pm", "4:00 pm", "4:30 pm", "5:00 pm", "5:30 pm",
    "9:00", "9:30", "10:00", "10:30", "11:00", "11:30",
    "1:00", "1:30", "2:00", "2:30", "3:00", "3:30", "4:00", "4:30", "5:00"
  ];

  const t = transcript.toLowerCase();
  let day = null;
  let time = null;

  for (const [full, short] of Object.entries(dayMap)) {
    if (t.includes(full)) { day = short; break; }
  }

  for (const tm of timePatterns) {
    if (t.includes(tm)) {
      if (tm.includes("am")) time = tm.replace("am","AM").replace(" am"," AM").trim();
      else if (tm.includes("pm")) time = tm.replace("pm","PM").replace(" pm"," PM").trim();
      else {
        const hour = parseInt(tm);
        time = `${tm} ${(hour >= 1 && hour <= 6) ? "PM" : "AM"}`;
      }
      break;
    }
  }

  if (!day || !time) {
    console.log("Could not extract appt details. Day:", day, "Time:", time, "Snippet:", transcript.slice(0,200));
    return null;
  }
  return { day, time };
}

// ── Bland.ai hiring phone screen webhook ──────────────────────────────────────
// POST /api/webhooks/bland-hiring
// Called after a phone screen completes. If passed → schedule Google Calendar interview,
// send applicant SMS + email, update applicant status.
router.post("/bland-hiring", async (req, res) => {
  const expectedSecret = process.env.BLAND_WEBHOOK_SECRET;
  if (!expectedSecret || req.query.secret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.status(200).json({ received: true });

  const payload = req.body;
  const { call_id, status, metadata } = payload;
  if (!call_id || !metadata?.applicant_id) return;

  const transcript = payload.concatenated_transcript || payload.transcript || "";
  const duration   = payload.corrected_duration
    ? Number(payload.corrected_duration)
    : payload.call_length ? Math.round(Number(payload.call_length) * 60) : 0;

  const { data: applicant } = await supabase
    .from("applicants")
    .select("*")
    .eq("id", metadata.applicant_id)
    .maybeSingle();

  if (!applicant) return;

  // Determine screen result
  const answeredBy = payload.answered_by || "unknown";
  let screenResult = "no_answer";
  if (answeredBy === "human" && duration >= 60) {
    const t = transcript.toLowerCase();
    const notInterested =
      t.includes("not interested") || t.includes("no thanks") ||
      t.includes("no thank you") || t.includes("don't call");
    screenResult = notInterested ? "failed" : "passed";
  } else if (answeredBy === "voicemail" || status === "voicemail") {
    screenResult = "no_answer";
  }

  // Update transcript + screen result
  await supabase
    .from("applicants")
    .update({
      screen_result:     screenResult,
      screen_transcript: transcript || null,
      status:            screenResult === "passed" ? "interview_scheduling" : "screened",
      updated_at:        new Date().toISOString(),
    })
    .eq("id", applicant.id);

  console.log(`[hiring] ${applicant.name} screen result: ${screenResult}`);

  if (screenResult !== "passed") return;

  // ── Schedule interview ───────────────────────────────────────────────────────
  try {
    const { getOrgClients, findFreeSlot, createInterviewEvent, sendInterviewEmail } = require("../lib/hiringCalendar");
    const { sendSms } = require("../lib/sms");

    const clients = await getOrgClients(applicant.org_id);
    if (!clients) {
      console.warn("[hiring] No calendar connected for org — skipping auto-schedule");
      await supabase
        .from("applicants")
        .update({ status: "screened", updated_at: new Date().toISOString() })
        .eq("id", applicant.id);
      return;
    }

    const { calendar, gmail, calendarId } = clients;

    // Find next open slot
    const slot = await findFreeSlot(calendar, calendarId);
    if (!slot) {
      console.warn("[hiring] No free slot found in next 14 days");
      return;
    }

    // Create calendar event
    const { eventId, meetLink } = await createInterviewEvent(calendar, calendarId, {
      applicantName:  applicant.name,
      applicantEmail: applicant.email,
      slot,
    });

    // Persist to DB
    await supabase
      .from("applicants")
      .update({
        status:          "interview_scheduled",
        interview_at:    slot.start.toISOString(),
        google_event_id: eventId,
        meet_link:       meetLink || null,
        updated_at:      new Date().toISOString(),
      })
      .eq("id", applicant.id);

    const formattedTime = slot.start.toLocaleString("en-US", {
      weekday: "long", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles",
    });

    // SMS to applicant
    if (applicant.phone) {
      const firstName = applicant.name.split(" ")[0];
      const smsBody = `Hi ${firstName}! Great news — you passed your phone screen for the Sales Rep position. Your interview is scheduled for ${formattedTime} (PT). Join via Google Meet: ${meetLink || "(link coming)"}. Reply STOP to opt out.`;
      try {
        await sendSms({ toPhone: applicant.phone, body: smsBody, source: "hiring" });
      } catch (smsErr) {
        console.warn("[hiring] SMS failed:", smsErr.message);
      }
    }

    // Email to applicant
    if (applicant.email && gmail) {
      try {
        await sendInterviewEmail(gmail, {
          toEmail:      applicant.email,
          applicantName: applicant.name,
          interviewAt:   slot.start,
          meetLink,
        });
      } catch (emailErr) {
        console.warn("[hiring] Email failed:", emailErr.message);
      }
    }

    console.log(`[hiring] Interview scheduled for ${applicant.name} at ${formattedTime}`);
  } catch (err) {
    console.error("[hiring] Schedule error:", err.message);
  }
});

module.exports = router;

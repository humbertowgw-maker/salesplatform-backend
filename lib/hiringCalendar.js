// lib/hiringCalendar.js — Google Calendar + Gmail helpers for the Vera hiring pipeline
const { google } = require("googleapis");
const supabase   = require("../db/supabase");

const INTERVIEW_MINS = 30;
const BIZ_START = 9;   // 9 AM
const BIZ_END   = 17;  // 5 PM
const TZ = "America/Los_Angeles";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/gmail.send",
];

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI_HIRING
  );
}

async function getOrgClients(orgId) {
  const { data: tok } = await supabase
    .from("org_calendar_tokens")
    .select("refresh_token")
    .eq("org_id", orgId)
    .maybeSingle();

  if (!tok?.refresh_token) return null;

  const auth = makeOAuthClient();
  auth.setCredentials({ refresh_token: tok.refresh_token });
  return {
    calendar:   google.calendar({ version: "v3", auth }),
    gmail:      google.gmail({ version: "v1", auth }),
    calendarId: "primary",
  };
}

// Find next open 30-min slot during business hours
async function findFreeSlot(calendar, calendarId) {
  // Start from 1 hour from now, rounded up to the next 30-min mark
  let candidate = new Date(Date.now() + 60 * 60 * 1000);
  const mins = candidate.getMinutes();
  if (mins % 30 !== 0) {
    candidate.setMinutes(mins < 30 ? 30 : 60, 0, 0);
  } else {
    candidate.setSeconds(0, 0);
  }

  const cutoff = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  while (candidate < cutoff) {
    const weekday = candidate.getDay();
    if (weekday === 0 || weekday === 6) {
      candidate.setDate(candidate.getDate() + (weekday === 6 ? 2 : 1));
      candidate.setHours(BIZ_START, 0, 0, 0);
      continue;
    }

    const localHour = parseInt(
      candidate.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: TZ }),
      10
    );

    if (localHour < BIZ_START) {
      candidate.setHours(candidate.getHours() + (BIZ_START - localHour), 0, 0, 0);
      continue;
    }
    if (localHour >= BIZ_END) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(BIZ_START, 0, 0, 0);
      continue;
    }

    const slotEnd = new Date(candidate.getTime() + INTERVIEW_MINS * 60 * 1000);

    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin:  candidate.toISOString(),
        timeMax:  slotEnd.toISOString(),
        items: [{ id: calendarId }],
      },
    });

    const busy = fb.data.calendars?.[calendarId]?.busy || [];
    if (busy.length === 0) return { start: candidate, end: slotEnd };

    // Jump past the conflict, round up to next 30-min mark
    const after = new Date(busy[0].end);
    const afterMins = after.getMinutes();
    if (afterMins % 30 !== 0) after.setMinutes(afterMins < 30 ? 30 : 60, 0, 0);
    else after.setSeconds(0, 0);
    candidate = after;
  }

  return null;
}

// Create Google Calendar event with Google Meet + applicant as attendee
async function createInterviewEvent(calendar, calendarId, { applicantName, applicantEmail, slot }) {
  const res = await calendar.events.insert({
    calendarId,
    conferenceDataVersion: 1,
    sendUpdates: "all",
    requestBody: {
      summary:     `Interview: ${applicantName}`,
      description: `Sales Rep candidate interview.\nApplicant: ${applicantName}`,
      start: { dateTime: slot.start.toISOString(), timeZone: TZ },
      end:   { dateTime: slot.end.toISOString(),   timeZone: TZ },
      attendees: applicantEmail ? [{ email: applicantEmail }] : [],
      conferenceData: {
        createRequest: {
          requestId: `hiring-${slot.start.getTime()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const meetLink = res.data.conferenceData?.entryPoints?.find(e => e.entryPointType === "video")?.uri || null;
  return { eventId: res.data.id, meetLink, htmlLink: res.data.htmlLink };
}

// Send interview confirmation email via Gmail API
async function sendInterviewEmail(gmail, { toEmail, applicantName, interviewAt, meetLink }) {
  if (!toEmail) return;

  const formatted = interviewAt.toLocaleString("en-US", {
    weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ,
  });

  const firstName = applicantName.split(" ")[0];
  const subject   = `Your Interview is Scheduled — ${formatted} (PT)`;
  const body = [
    `Hi ${firstName},`,
    "",
    "Congratulations on passing your initial phone screen! Your interview has been scheduled.",
    "",
    `Date & Time: ${formatted} (Pacific Time)`,
    `Google Meet: ${meetLink || "(link will be sent separately)"}`,
    "",
    "Please join the video call a few minutes early. If you need to reschedule, reply to this email.",
    "",
    "Looking forward to meeting you!",
    "",
    "White Glove Wireless Hiring Team",
  ].join("\r\n");

  const raw = [
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: Buffer.from(raw).toString("base64url") },
  });
}

module.exports = { makeOAuthClient, getOrgClients, findFreeSlot, createInterviewEvent, sendInterviewEmail, SCOPES };

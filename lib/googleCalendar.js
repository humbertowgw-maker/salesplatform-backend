// lib/googleCalendar.js — per-rep Google Calendar helpers (one-way: WGW → Google)
const { google } = require("googleapis");
const supabase = require("../db/supabase");

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function getCalendarForRep(repId) {
  const { data: tok } = await supabase
    .from("rep_google_tokens")
    .select("refresh_token, calendar_id")
    .eq("rep_id", repId)
    .maybeSingle();

  if (!tok || !tok.refresh_token) return null;

  const auth = makeOAuthClient();
  auth.setCredentials({ refresh_token: tok.refresh_token });
  const calendar = google.calendar({ version: "v3", auth });
  return { calendar, calendarId: tok.calendar_id || "primary" };
}

function buildEventTimes(appt) {
  const tz = "America/Los_Angeles";
  const date = appt.scheduled_date || new Date().toISOString().slice(0, 10);
  const time = (appt.scheduled_time || "09:00").trim();
  let hh = 9, mm = 0;
  const m = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (m) {
    hh = parseInt(m[1], 10);
    mm = parseInt(m[2], 10);
    const ap = (m[3] || "").toUpperCase();
    if (ap === "PM" && hh < 12) hh += 12;
    if (ap === "AM" && hh === 12) hh = 0;
  }
  const start = `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
  const endHh = (hh + 1) % 24;
  const end = `${date}T${String(endHh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
  return {
    start: { dateTime: start, timeZone: tz },
    end:   { dateTime: end,   timeZone: tz },
  };
}

function buildEventBody(appt) {
  const times = buildEventTimes(appt);
  const summary = `WGW Appt: ${appt.business_name || "Appointment"}`;
  const descLines = [
    appt.owner_name ? `Owner: ${appt.owner_name}` : null,
    appt.address ? `Address: ${appt.address}` : null,
    appt.territory ? `Territory: ${appt.territory}` : null,
    appt.status ? `Status: ${appt.status}` : null,
    appt.notes ? `Notes: ${appt.notes}` : null,
  ].filter(Boolean);
  return {
    summary,
    location: appt.address || undefined,
    description: descLines.join("\n"),
    ...times,
  };
}

async function mirrorCreate(appt) {
  try {
    const c = await getCalendarForRep(appt.rep_id);
    if (!c) return null;
    const { data } = await c.calendar.events.insert({
      calendarId: c.calendarId,
      requestBody: buildEventBody(appt),
    });
    return data.id || null;
  } catch (e) {
    console.warn("[gcal] create failed:", e.message);
    return null;
  }
}

async function mirrorUpdate(appt) {
  try {
    if (!appt.google_event_id) return await mirrorCreate(appt);
    const c = await getCalendarForRep(appt.rep_id);
    if (!c) return appt.google_event_id;
    await c.calendar.events.update({
      calendarId: c.calendarId,
      eventId: appt.google_event_id,
      requestBody: buildEventBody(appt),
    });
    return appt.google_event_id;
  } catch (e) {
    console.warn("[gcal] update failed:", e.message);
    return appt.google_event_id || null;
  }
}

async function mirrorDelete(repId, googleEventId) {
  try {
    if (!googleEventId) return;
    const c = await getCalendarForRep(repId);
    if (!c) return;
    await c.calendar.events.delete({
      calendarId: c.calendarId,
      eventId: googleEventId,
    });
  } catch (e) {
    console.warn("[gcal] delete failed:", e.message);
  }
}

module.exports = {
  makeOAuthClient,
  getCalendarForRep,
  mirrorCreate,
  mirrorUpdate,
  mirrorDelete,
};

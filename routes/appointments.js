// routes/appointments.js — Appointment booking + rep assignment
const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");
const { mirrorCreate, mirrorUpdate, mirrorDelete } = require("../lib/googleCalendar");

// GET /api/appointments
router.get("/", async (req, res) => {
  const { rep_id, status, day } = req.query;
  try {
    let query = supabase
      .from("appointments")
      .select(`*, reps(name, color, phone)`)
      .order("scheduled_date", { ascending: true });

    if (rep_id) query = query.eq("rep_id", rep_id);
    if (status) query = query.eq("status", status);
    if (day)    query = query.eq("scheduled_day", day);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ appointments: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/appointments — book a new appointment
router.post("/", async (req, res) => {
  const {
    lead_id, rep_id, business_name, owner_name,
    address, scheduled_day, scheduled_time, scheduled_date,
    territory, booked_by, notes,
  } = req.body;

  if (!business_name || !scheduled_day || !scheduled_time || !rep_id) {
    return res.status(400).json({
      error: "business_name, scheduled_day, scheduled_time, and rep_id are required",
    });
  }

  try {
    // Check for conflicts — same rep, same day, same time
    const { data: conflict } = await supabase
      .from("appointments")
      .select("id")
      .eq("rep_id", rep_id)
      .eq("scheduled_day", scheduled_day)
      .eq("scheduled_time", scheduled_time)
      .not("status", "in", '("Cancelled","No Show")')
      .maybeSingle();

    if (conflict) {
      return res.status(409).json({
        error: "That time slot is already booked for this rep.",
        conflict_id: conflict.id,
      });
    }

    const { data, error } = await supabase
      .from("appointments")
      .insert({
        lead_id, rep_id, business_name, owner_name, address,
        scheduled_day, scheduled_time,
        scheduled_date: scheduled_date || null,
        territory, booked_by: booked_by || "Manual", notes,
        status: "Pending",
      })
      .select(`*, reps(name, color)`)
      .single();

    if (error) throw error;

    // Mirror to Google Calendar
    const googleEventId = await mirrorCreate(data);
    if (googleEventId) {
      await supabase
        .from("appointments")
        .update({ google_event_id: googleEventId })
        .eq("id", data.id);
      data.google_event_id = googleEventId;
    }

    // Update lead status to "Appt Set"
    if (lead_id) {
      await supabase
        .from("leads")
        .update({ status: "Appt Set" })
        .eq("id", lead_id);
    }

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/appointments/:id
router.patch("/:id", async (req, res) => {
  const allowed = ["status", "rep_id", "scheduled_day", "scheduled_time", "scheduled_date", "notes", "territory"];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  try {
    const { data, error } = await supabase
      .from("appointments")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();
    if (error) throw error;

    // Mirror to Google Calendar
    const googleEventId = await mirrorUpdate(data);
    if (googleEventId && googleEventId !== data.google_event_id) {
      await supabase
        .from("appointments")
        .update({ google_event_id: googleEventId })
        .eq("id", data.id);
      data.google_event_id = googleEventId;
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/appointments/:id
router.delete("/:id", async (req, res) => {
  try {
    const { data: appt } = await supabase
      .from("appointments")
      .select("rep_id, google_event_id")
      .eq("id", req.params.id)
      .maybeSingle();

    const { error } = await supabase.from("appointments").delete().eq("id", req.params.id);
    if (error) throw error;

    if (appt) await mirrorDelete(appt.rep_id, appt.google_event_id);

    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

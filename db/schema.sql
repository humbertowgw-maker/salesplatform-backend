-- ─── WHITE GLOVE WIRELESS · SUPABASE DATABASE SCHEMA ────────────────────────
-- Run this entire file in: Supabase Dashboard → SQL Editor → New Query → Run

-- ── REPS ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT UNIQUE,
  phone       TEXT,
  color       TEXT DEFAULT '#f97316',
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── TERRITORIES ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS territories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  zip_codes   TEXT[],          -- array of ZIP codes in this territory
  rep_id      UUID REFERENCES reps(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── LEADS ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name     TEXT NOT NULL,
  business_type     TEXT,
  owner_name        TEXT,
  owner_email       TEXT,
  phone             TEXT,
  address           TEXT,
  city              TEXT,
  state             TEXT DEFAULT 'WA',
  zip               TEXT,
  current_provider  TEXT,
  estimated_lines   INT,
  rep_id            UUID REFERENCES reps(id) ON DELETE SET NULL,
  territory_id      UUID REFERENCES territories(id) ON DELETE SET NULL,
  status            TEXT DEFAULT 'New'
                    CHECK (status IN ('New','Called','Texted','No Answer','Voicemail','Appt Set','Not Interested','Converted')),
  fcc_checked       BOOLEAN DEFAULT false,
  fcc_providers     JSONB,       -- raw FCC provider data for this address
  priority_score    INT,         -- 1–10, set by AI
  source            TEXT[],      -- ['Google Places', 'Apollo.io', etc.]
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- ── APPOINTMENTS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID REFERENCES leads(id) ON DELETE CASCADE,
  rep_id          UUID REFERENCES reps(id) ON DELETE SET NULL,
  business_name   TEXT NOT NULL,
  owner_name      TEXT,
  address         TEXT,
  scheduled_day   TEXT NOT NULL,   -- 'Mon', 'Tue', etc.
  scheduled_time  TEXT NOT NULL,   -- '10:00 AM'
  scheduled_date  DATE,
  territory       TEXT,
  status          TEXT DEFAULT 'Pending'
                  CHECK (status IN ('Pending','Confirmed','Completed','Cancelled','No Show')),
  booked_by       TEXT DEFAULT 'AI' CHECK (booked_by IN ('AI','Manual')),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ── CALL LOGS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID REFERENCES leads(id) ON DELETE SET NULL,
  bland_call_id       TEXT UNIQUE,    -- Bland.ai's call ID for lookup
  phone_number        TEXT,
  status              TEXT,           -- completed, no-answer, voicemail, failed
  duration_seconds    INT,
  transcript          TEXT,
  outcome             TEXT,           -- appointment_booked, callback_requested, not_interested
  appointment_id      UUID REFERENCES appointments(id) ON DELETE SET NULL,
  recording_url       TEXT,
  cost_usd            NUMERIC(6,4),
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- ── TEXT LOGS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS text_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
  twilio_sid      TEXT UNIQUE,
  direction       TEXT CHECK (direction IN ('outbound','inbound')),
  body            TEXT,
  phone_from      TEXT,
  phone_to        TEXT,
  status          TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── UPDATED_AT TRIGGER ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── SEED: INITIAL REPS ────────────────────────────────────────────────────────
INSERT INTO reps (name, phone, color) VALUES
  ('Jesse Torres',  '(425) 555-0011', '#f97316'),
  ('Sofia Reyes',   '(425) 555-0022', '#3b82f6'),
  ('Marco Cruz',    '(425) 555-0033', '#10b981')
ON CONFLICT DO NOTHING;

-- ── USEFUL VIEWS ──────────────────────────────────────────────────────────────

-- Dashboard summary per rep
CREATE OR REPLACE VIEW rep_dashboard AS
SELECT
  r.id,
  r.name,
  r.color,
  COUNT(DISTINCT l.id)                                          AS total_leads,
  COUNT(DISTINCT a.id)                                          AS total_appointments,
  COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'Confirmed')   AS confirmed_appointments,
  COUNT(DISTINCT cl.id)                                         AS total_calls,
  COUNT(DISTINCT tl.id)                                         AS total_texts
FROM reps r
LEFT JOIN leads l        ON l.rep_id = r.id
LEFT JOIN appointments a ON a.rep_id = r.id
LEFT JOIN call_logs cl   ON cl.lead_id = l.id
LEFT JOIN text_logs tl   ON tl.lead_id = l.id
WHERE r.active = true
GROUP BY r.id, r.name, r.color;

-- Full lead pipeline view
CREATE OR REPLACE VIEW lead_pipeline AS
SELECT
  l.*,
  r.name  AS rep_name,
  r.color AS rep_color,
  t.name  AS territory_name,
  COUNT(cl.id)  AS call_count,
  COUNT(tl.id)  AS text_count,
  MAX(a.scheduled_date) AS next_appointment_date
FROM leads l
LEFT JOIN reps r          ON r.id = l.rep_id
LEFT JOIN territories t   ON t.id = l.territory_id
LEFT JOIN call_logs cl    ON cl.lead_id = l.id
LEFT JOIN text_logs tl    ON tl.lead_id = l.id
LEFT JOIN appointments a  ON a.lead_id = l.id AND a.status NOT IN ('Cancelled','No Show')
GROUP BY l.id, r.name, r.color, t.name;

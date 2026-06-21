-- Sales Platform Phase 3 — New feature tables
-- Run in Supabase SQL Editor after phase2 migration

-- ── NOTIFICATIONS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_email  TEXT,            -- null = broadcast to all org users
  title       TEXT NOT NULL,
  body        TEXT,
  type        TEXT DEFAULT 'info' CHECK (type IN ('info','success','warning','error','action')),
  link        TEXT,            -- optional deep link to a module
  read        BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_org_id_idx ON notifications(org_id);
CREATE INDEX IF NOT EXISTS notifications_user_email_idx ON notifications(user_email);
CREATE INDEX IF NOT EXISTS notifications_read_idx ON notifications(read);

-- ── ACTIVITY LOG ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_email  TEXT,
  rep_id      UUID REFERENCES reps(id) ON DELETE SET NULL,
  lead_id     UUID REFERENCES leads(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL,  -- lead_added, call_made, sms_sent, appt_booked, etc.
  description TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_org_id_idx ON activity_log(org_id);
CREATE INDEX IF NOT EXISTS activity_log_lead_id_idx ON activity_log(lead_id);
CREATE INDEX IF NOT EXISTS activity_log_event_type_idx ON activity_log(event_type);
CREATE INDEX IF NOT EXISTS activity_log_created_at_idx ON activity_log(created_at DESC);

-- ── REP GOALS (weekly) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rep_goals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id          UUID REFERENCES reps(id) ON DELETE CASCADE,
  week_start      DATE NOT NULL,
  calls_target    INT DEFAULT 0,
  appts_target    INT DEFAULT 0,
  revenue_target  NUMERIC(10,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, rep_id, week_start)
);

-- ── FIELD CHECK-INS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_checkins (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id      UUID REFERENCES reps(id) ON DELETE SET NULL,
  lat         NUMERIC(10,7) NOT NULL,
  lng         NUMERIC(10,7) NOT NULL,
  address     TEXT,
  note        TEXT,
  lead_id     UUID REFERENCES leads(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS field_checkins_org_id_idx ON field_checkins(org_id);
CREATE INDEX IF NOT EXISTS field_checkins_rep_id_idx ON field_checkins(rep_id);
CREATE INDEX IF NOT EXISTS field_checkins_created_at_idx ON field_checkins(created_at DESC);

-- ── FIELD ROUTES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_routes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id      UUID REFERENCES reps(id) ON DELETE CASCADE,
  name        TEXT DEFAULT 'Route',
  waypoints   JSONB NOT NULL,   -- array of {name, address, lat, lng, lead_id}
  route_date  DATE,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── SCORING WEIGHTS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scoring_weights (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,
  weights        JSONB NOT NULL,
  custom_fields  JSONB DEFAULT '[]',
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- ── DOCUMENTS (generalized document intake + Claude analysis) ─────────────────
CREATE TABLE IF NOT EXISTS documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id        UUID REFERENCES leads(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  document_type  TEXT DEFAULT 'general',
  content_text   TEXT,
  storage_url    TEXT,
  analysis       JSONB,
  status         TEXT DEFAULT 'pending' CHECK (status IN ('pending','analyzing','analyzed','error')),
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_org_id_idx ON documents(org_id);
CREATE INDEX IF NOT EXISTS documents_lead_id_idx ON documents(lead_id);

-- ── ORGANIZATIONS extra columns ───────────────────────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS news_topics JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS brand_name TEXT,
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS primary_color TEXT DEFAULT '#6366f1',
  ADD COLUMN IF NOT EXISTS ai_name TEXT DEFAULT 'Alex',
  ADD COLUMN IF NOT EXISTS tagline TEXT;

-- ── LEADS extra columns ───────────────────────────────────────────────────────
-- Remove the fixed WA default and remove status constraint so pipeline stages are flexible
ALTER TABLE leads
  ALTER COLUMN state DROP DEFAULT;

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_status_check;

-- ── REPS extra columns ───────────────────────────────────────────────────────
ALTER TABLE reps
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS title TEXT;

-- Make sure call_logs and appointments have org_id and rep_id
ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS business_name TEXT,
  ADD COLUMN IF NOT EXISTS owner_name TEXT,
  ADD COLUMN IF NOT EXISTS rep_name TEXT,
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS answered_by TEXT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS org_id UUID;

ALTER TABLE text_logs
  ADD COLUMN IF NOT EXISTS org_id UUID,
  ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT false;

-- Updated_at trigger for new tables
DROP TRIGGER IF EXISTS rep_goals_updated_at ON rep_goals;
CREATE TRIGGER rep_goals_updated_at
  BEFORE UPDATE ON rep_goals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS documents_updated_at ON documents;
CREATE TRIGGER documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── SALESPLATFORM MIGRATION — run in Supabase SQL Editor ──────────────────────
-- Project: qjopxyshrjyrjbfbhyda

-- ── ORGANIZATIONS: missing columns ───────────────────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS industry_key        TEXT DEFAULT 'general_crm',
  ADD COLUMN IF NOT EXISTS enabled_modules     JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS custom_wording      JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS pipeline_stages     JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS research_tools      JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS news_topics         JSONB DEFAULT '[]';

-- ── CALL_LOGS: missing columns ───────────────────────────────────────────────
ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS rep_id   UUID REFERENCES reps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS summary  TEXT;

-- ── REPS: missing columns ────────────────────────────────────────────────────
ALTER TABLE reps
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS title  TEXT;

-- ── TEXT_LOGS: missing columns ───────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'text_logs') THEN
    EXECUTE 'ALTER TABLE text_logs ADD COLUMN IF NOT EXISTS org_id UUID, ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT false';
  END IF;
END $$;

-- ── APPOINTMENTS: missing columns ────────────────────────────────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS org_id UUID;

-- ── ACTIVITY LOG ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_email  TEXT,
  rep_id      UUID REFERENCES reps(id) ON DELETE SET NULL,
  lead_id     UUID REFERENCES leads(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL,
  description TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_org_id_idx      ON activity_log(org_id);
CREATE INDEX IF NOT EXISTS activity_log_lead_id_idx     ON activity_log(lead_id);
CREATE INDEX IF NOT EXISTS activity_log_event_type_idx  ON activity_log(event_type);
CREATE INDEX IF NOT EXISTS activity_log_created_at_idx  ON activity_log(created_at DESC);

-- ── DOCUMENTS ────────────────────────────────────────────────────────────────
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
CREATE INDEX IF NOT EXISTS documents_org_id_idx  ON documents(org_id);
CREATE INDEX IF NOT EXISTS documents_lead_id_idx ON documents(lead_id);

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
CREATE INDEX IF NOT EXISTS field_checkins_org_id_idx    ON field_checkins(org_id);
CREATE INDEX IF NOT EXISTS field_checkins_rep_id_idx    ON field_checkins(rep_id);
CREATE INDEX IF NOT EXISTS field_checkins_created_at_idx ON field_checkins(created_at DESC);

-- ── FIELD ROUTES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_routes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id      UUID REFERENCES reps(id) ON DELETE CASCADE,
  name        TEXT DEFAULT 'Route',
  waypoints   JSONB NOT NULL,
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

-- ── FEATURE REQUESTS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_email  TEXT,
  title       TEXT NOT NULL,
  module      TEXT,
  priority    TEXT DEFAULT 'normal',
  description TEXT,
  status      TEXT DEFAULT 'open',
  votes       INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now()
);


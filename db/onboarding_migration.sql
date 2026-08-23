-- ─── WGW REP ONBOARDING & ACCESS REQUESTS MIGRATION ─────────────────────────
-- Run this entire file in: Supabase Dashboard → SQL Editor → New Query → Run
-- Adds: access_requests, rep_onboarding, rep_timeline_events + rep-docs bucket

-- ── ACCESS REQUESTS (self-serve "Request Access" from the sign-in page) ─────
CREATE TABLE IF NOT EXISTS access_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,
  platform        TEXT NOT NULL DEFAULT 'sales_platform'
                  CHECK (platform IN ('sales_platform','sales_trainer','phone_agent','other')),
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','denied')),
  requested_role  TEXT DEFAULT 'rep',
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  converted_rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_requests_org_status_idx ON access_requests (org_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_open_email_idx
  ON access_requests (lower(email)) WHERE status = 'pending';

-- ── REP ONBOARDING (one row per rep; compliance checklist state) ─────────────
CREATE TABLE IF NOT EXISTS rep_onboarding (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id                UUID NOT NULL UNIQUE REFERENCES reps(id) ON DELETE CASCADE,
  stage                 TEXT NOT NULL DEFAULT 'account_created',
  -- personal info
  address_line1         TEXT, city TEXT, state TEXT, zip TEXT,
  dob                   TEXT,
  emergency_name        TEXT, emergency_phone TEXT,
  profile_submitted_at  TIMESTAMPTZ,
  -- IRS paperwork (W-4 employee / W-9 contractor)
  irs_form_type         TEXT CHECK (irs_form_type IN ('W-4','W-9')),
  irs_form_url          TEXT,
  irs_signed_at         TIMESTAMPTZ,
  irs_filed_at          TIMESTAMPTZ,
  irs_filed_year        TEXT,
  -- driver's license
  dl_state              TEXT, dl_expiry TEXT,
  dl_url                TEXT,
  dl_uploaded_at        TIMESTAMPTZ,
  -- I-9 work authorization
  i9_citizenship_status TEXT,
  i9_doc_type           TEXT,
  i9_completed_at       TIMESTAMPTZ,
  -- direct deposit
  bank_name             TEXT, account_last4 TEXT, routing_number TEXT,
  deposit_completed_at  TIMESTAMPTZ,
  -- lifecycle
  started_at            TIMESTAMPTZ DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- ── REP TIMELINE EVENTS (audit trail shown on the Reps page) ────────────────
CREATE TABLE IF NOT EXISTS rep_timeline_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id      UUID REFERENCES reps(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- e.g. request_received | approved | account_created | welcome_sent | profile_submitted | irs_received | irs_filed | license_uploaded | i9_completed | deposit_added | onboarding_completed | manual_note
  label       TEXT NOT NULL,
  detail      JSONB,
  actor       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rep_timeline_rep_idx ON rep_timeline_events (rep_id, created_at);

-- ── STORAGE: private bucket for onboarding documents (IRS forms, DL, I-9) ───
INSERT INTO storage.buckets (id, name, public)
VALUES ('rep-docs', 'rep-docs', false)
ON CONFLICT (id) DO NOTHING;

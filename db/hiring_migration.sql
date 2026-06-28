-- hiring_migration.sql — Vera hiring pipeline
-- Run in Supabase SQL editor for project qzudlurqmhstdrzorlxu

-- Applicants pipeline table
CREATE TABLE IF NOT EXISTS applicants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL,
  name                TEXT NOT NULL,
  phone               TEXT,
  email               TEXT,
  position            TEXT DEFAULT 'Sales Rep',
  status              TEXT DEFAULT 'applied',
  bland_call_id       TEXT,
  screen_result       TEXT,
  screen_transcript   TEXT,
  interview_at        TIMESTAMPTZ,
  google_event_id     TEXT,
  meet_link           TEXT,
  offer_sent_at       TIMESTAMPTZ,
  hired_at            TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS applicants_org_id_idx ON applicants(org_id);
CREATE INDEX IF NOT EXISTS applicants_status_idx ON applicants(status);

-- Hiring manager Google OAuth tokens (one per org — used for calendar + gmail)
CREATE TABLE IF NOT EXISTS org_calendar_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID UNIQUE NOT NULL,
  refresh_token TEXT NOT NULL,
  email         TEXT,
  connected_at  TIMESTAMPTZ DEFAULT NOW()
);

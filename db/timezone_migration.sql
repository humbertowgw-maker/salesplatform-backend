-- timezone_migration.sql
-- Run once in Supabase SQL Editor for project qzudlurqmhstdrzorlxu

-- ── territories: per-territory calling hours ─────────────────────────────────
ALTER TABLE territories
  ADD COLUMN IF NOT EXISTS calling_start_local TIME DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS calling_end_local   TIME DEFAULT '20:00';

-- ── leads: timezone + language + calling window ───────────────────────────────
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS timezone               TEXT,
  ADD COLUMN IF NOT EXISTS preferred_language     TEXT DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS language_confidence    TEXT DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS sophia_voice_profile   TEXT DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS calling_window_start   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS calling_window_end     TIMESTAMPTZ;

-- ── call_queue: per-row window copied from lead at enqueue time ───────────────
ALTER TABLE call_queue
  ADD COLUMN IF NOT EXISTS local_call_window_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS local_call_window_end   TIMESTAMPTZ;

-- ── agent_registry: AI-generated build plan ───────────────────────────────────
ALTER TABLE agent_registry
  ADD COLUMN IF NOT EXISTS build_plan_json JSONB;

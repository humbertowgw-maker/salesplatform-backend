-- agents_migration.sql — Agent registry + supporting tables
-- Run once against Supabase project qzudlurqmhstdrzorlxu

-- ── agent_registry ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_registry (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name         text NOT NULL,
  slug         text NOT NULL UNIQUE,
  description  text,
  category     text NOT NULL DEFAULT 'automation',
  status       text NOT NULL DEFAULT 'proposed'
               CHECK (status IN ('proposed','active','inactive')),
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,
  activated_at timestamptz,
  last_run_at  timestamptz,
  run_count    integer NOT NULL DEFAULT 0,
  config       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── agent_audit_log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_audit_log (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_id     uuid REFERENCES agent_registry(id) ON DELETE CASCADE,
  action       text NOT NULL,
  performed_by text,
  details      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── eod_reports ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eod_reports (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  date        date NOT NULL,
  summary     text,
  briefing    text,
  suggestions jsonb NOT NULL DEFAULT '[]',
  metrics     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, date)
);

-- ── improvement_suggestions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS improvement_suggestions (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  suggestion  text NOT NULL,
  source      text NOT NULL DEFAULT 'eod_report',
  priority    text NOT NULL DEFAULT 'normal'
              CHECK (priority IN ('low','normal','high')),
  actioned_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── language_profiles ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS language_profiles (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  area_code      text,
  zip_prefix     text,
  city           text,
  state          text,
  primary_lang   text NOT NULL DEFAULT 'en',
  secondary_lang text,
  timezone       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ── call_queue ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_queue (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id      uuid REFERENCES leads(id) ON DELETE CASCADE,
  priority     integer NOT NULL DEFAULT 5,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','dialing','completed','skipped','failed')),
  voice_profile text NOT NULL DEFAULT 'en',
  scheduled_at timestamptz,
  dialed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── queue_health_log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queue_health_log (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id       uuid,
  total_leads  integer NOT NULL DEFAULT 0,
  active_leads integer NOT NULL DEFAULT 0,
  stale_leads  integer NOT NULL DEFAULT 0,
  queue_size   integer NOT NULL DEFAULT 0,
  health_score numeric(5,2) NOT NULL DEFAULT 0,
  issues       jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Seed agents ───────────────────────────────────────────────────────────────
INSERT INTO agent_registry (name, slug, description, category, status) VALUES
  ('Director',           'director',      'AI orchestration director — daily briefings, performance assessment, task assignment', 'core',        'active'),
  ('Sophia Dialer',      'sophia',        'AI voice dialer — auto-dials call queue with EN/ES/VI voice profiles',                'outreach',    'active'),
  ('Scout',              'scout',         'Google Places lead discovery — finds new businesses in target areas',                  'acquisition', 'active'),
  ('Atlas',              'atlas',         'Territory enrichment — labels leads with timezone and language profiles',              'enrichment',  'active'),
  ('Pulse',              'pulse',         'Analytics monitor — watches KPIs and surfaces anomalies',                             'analytics',   'active'),
  ('Executor',           'executor',      'Task executor — processes queued agent jobs',                                         'core',        'active'),
  ('Territory Agent',    'territory',     'Enriches leads with TZ and language profiles for targeted outreach',                  'enrichment',  'active'),
  ('Orchestrator',       'orchestrator',  'Queue health orchestrator — runs health cycles and rebalances call queue',            'core',        'active'),
  ('Follow-Up Agent',    'follow-up',     'Re-engages stale leads within 3-attempt cap',                                        'outreach',    'active'),
  ('Queue Health Agent', 'queue-health',  'Monitors call queue health, flags stale leads, reports issues',                      'monitoring',  'proposed'),
  ('Lead Scout Agent',   'lead-scout',    'Google Places powered lead discovery and enrichment pipeline',                        'acquisition', 'proposed'),
  ('EOD Report Agent',   'eod-report',    'Nightly end-of-day summary: metrics, director briefing, improvement suggestions',     'reporting',   'proposed')
ON CONFLICT (slug) DO UPDATE SET
  name        = EXCLUDED.name,
  description = EXCLUDED.description,
  category    = EXCLUDED.category;

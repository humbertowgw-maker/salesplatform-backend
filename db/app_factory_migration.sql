-- Sales Platform app-factory configuration
-- Run in Supabase SQL Editor after the base schema.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS industry_key TEXT DEFAULT 'general_crm',
  ADD COLUMN IF NOT EXISTS enabled_modules JSONB,
  ADD COLUMN IF NOT EXISTS custom_wording JSONB,
  ADD COLUMN IF NOT EXISTS pipeline_stages JSONB,
  ADD COLUMN IF NOT EXISTS research_tools JSONB;

CREATE TABLE IF NOT EXISTS feature_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by TEXT,
  title TEXT NOT NULL,
  description TEXT,
  module TEXT,
  status TEXT DEFAULT 'requested'
    CHECK (status IN ('requested','reviewing','planned','shipped','declined')),
  priority TEXT DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feature_requests_org_id_idx ON feature_requests(org_id);
CREATE INDEX IF NOT EXISTS feature_requests_status_idx ON feature_requests(status);

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;

DROP TRIGGER IF EXISTS feature_requests_updated_at ON feature_requests;
CREATE TRIGGER feature_requests_updated_at
  BEFORE UPDATE ON feature_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

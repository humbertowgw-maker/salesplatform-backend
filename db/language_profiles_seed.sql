-- Language profiles seed: area code → language / timezone mapping
-- Run in Supabase SQL editor. Uses UPSERT so it's safe to re-run.

INSERT INTO language_profiles (area_code, language, timezone, region_name)
VALUES
  -- Southern California (Spanish-dominant)
  ('213', 'es', 'America/Los_Angeles', 'Los Angeles (Central)'),
  ('323', 'es', 'America/Los_Angeles', 'East Los Angeles / Hollywood'),
  ('626', 'es', 'America/Los_Angeles', 'San Gabriel Valley / Pasadena'),
  ('818', 'es', 'America/Los_Angeles', 'San Fernando Valley'),
  ('562', 'es', 'America/Los_Angeles', 'Long Beach / East LA'),
  ('310', 'es', 'America/Los_Angeles', 'West LA / Compton / Inglewood'),
  ('424', 'es', 'America/Los_Angeles', 'South Bay / West LA (overlay)'),
  ('442', 'es', 'America/Los_Angeles', 'San Bernardino / Riverside'),
  ('951', 'es', 'America/Los_Angeles', 'Riverside County'),
  ('909', 'es', 'America/Los_Angeles', 'Inland Empire'),

  -- Orange County (Vietnamese-dominant pockets + Spanish)
  ('714', 'vi', 'America/Los_Angeles', 'Orange County / Little Saigon'),
  ('657', 'vi', 'America/Los_Angeles', 'Orange County (overlay)'),
  ('949', 'vi', 'America/Los_Angeles', 'South Orange County / Irvine'),

  -- Northern California (Spanish)
  ('415', 'es', 'America/Los_Angeles', 'San Francisco / Mission District'),
  ('408', 'es', 'America/Los_Angeles', 'San Jose / Silicon Valley'),
  ('650', 'es', 'America/Los_Angeles', 'Peninsula / Palo Alto'),
  ('831', 'es', 'America/Los_Angeles', 'Monterey / Salinas'),
  ('209', 'es', 'America/Los_Angeles', 'Central Valley / Stockton / Modesto'),
  ('559', 'es', 'America/Los_Angeles', 'Fresno / Central Valley'),
  ('661', 'es', 'America/Los_Angeles', 'Bakersfield / Kern County'),
  ('760', 'es', 'America/Los_Angeles', 'Coachella Valley / Imperial'),
  ('619', 'es', 'America/Los_Angeles', 'San Diego / National City / Chula Vista'),
  ('858', 'es', 'America/Los_Angeles', 'North San Diego'),

  -- Texas (Spanish)
  ('956', 'es', 'America/Chicago', 'Rio Grande Valley / McAllen / Laredo'),
  ('956', 'es', 'America/Chicago', 'Rio Grande Valley'),
  ('210', 'es', 'America/Chicago', 'San Antonio'),
  ('915', 'es', 'America/Denver', 'El Paso'),
  ('512', 'es', 'America/Chicago', 'Austin area'),
  ('713', 'es', 'America/Chicago', 'Houston (central)'),
  ('832', 'es', 'America/Chicago', 'Houston (overlay)'),

  -- Pacific Northwest (English)
  ('206', 'en', 'America/Los_Angeles', 'Seattle'),
  ('253', 'en', 'America/Los_Angeles', 'Tacoma / South Sound'),
  ('425', 'en', 'America/Los_Angeles', 'Bellevue / Eastside'),
  ('360', 'en', 'America/Los_Angeles', 'Western Washington'),
  ('503', 'en', 'America/Los_Angeles', 'Portland, OR'),
  ('971', 'en', 'America/Los_Angeles', 'Portland metro (overlay)'),

  -- English defaults — major metro areas
  ('212', 'en', 'America/New_York',  'New York City (Manhattan)'),
  ('718', 'en', 'America/New_York',  'New York City (outer boroughs)'),
  ('312', 'en', 'America/Chicago',   'Chicago'),
  ('404', 'en', 'America/New_York',  'Atlanta'),
  ('602', 'en', 'America/Phoenix',   'Phoenix'),
  ('702', 'en', 'America/Los_Angeles', 'Las Vegas'),
  ('303', 'en', 'America/Denver',    'Denver')

ON CONFLICT (area_code) DO UPDATE
  SET language    = EXCLUDED.language,
      timezone    = EXCLUDED.timezone,
      region_name = EXCLUDED.region_name;

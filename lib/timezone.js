// lib/timezone.js — State timezone mapping + lead calling-window enrichment
const supabase = require('../db/supabase');

const STATE_TIMEZONE = {
  AL: 'America/Chicago',              AK: 'America/Anchorage',
  AZ: 'America/Phoenix',              AR: 'America/Chicago',
  CA: 'America/Los_Angeles',          CO: 'America/Denver',
  CT: 'America/New_York',             DE: 'America/New_York',
  FL: 'America/New_York',             GA: 'America/New_York',
  HI: 'Pacific/Honolulu',             ID: 'America/Denver',
  IL: 'America/Chicago',              IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',              KS: 'America/Chicago',
  KY: 'America/New_York',             LA: 'America/Chicago',
  ME: 'America/New_York',             MD: 'America/New_York',
  MA: 'America/New_York',             MI: 'America/Detroit',
  MN: 'America/Chicago',              MS: 'America/Chicago',
  MO: 'America/Chicago',              MT: 'America/Denver',
  NE: 'America/Chicago',              NV: 'America/Los_Angeles',
  NH: 'America/New_York',             NJ: 'America/New_York',
  NM: 'America/Denver',               NY: 'America/New_York',
  NC: 'America/New_York',             ND: 'America/Chicago',
  OH: 'America/New_York',             OK: 'America/Chicago',
  OR: 'America/Los_Angeles',          PA: 'America/New_York',
  RI: 'America/New_York',             SC: 'America/New_York',
  SD: 'America/Chicago',              TN: 'America/Chicago',
  TX: 'America/Chicago',              UT: 'America/Denver',
  VT: 'America/New_York',             VA: 'America/New_York',
  WA: 'America/Los_Angeles',          WV: 'America/New_York',
  WI: 'America/Chicago',              WY: 'America/Denver',
  DC: 'America/New_York',             PR: 'America/Puerto_Rico',
};

// FCC TCPA safe harbor: 9 AM – 8 PM local time
const FCC_START = 9;
const FCC_END   = 20;

/**
 * Compute today's calling window [start, end] as UTC ISO strings.
 * Uses Intl to determine the live UTC offset so DST is handled automatically.
 */
function computeCallingWindow(timezone, startHour = FCC_START, endHour = FCC_END) {
  const now = new Date();

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type) => parseInt(parts.find(p => p.type === type).value);
  const year = get('year'), month = get('month') - 1, day = get('day');
  const localHour = get('hour');

  // Offset in hours: may span midnight, so clamp to ±14
  let offset = localHour - now.getUTCHours();
  if (offset > 14)  offset -= 24;
  if (offset < -14) offset += 24;

  // UTC = local − offset  →  setUTCHours subtracts the offset
  const makeUTC = (lh) => {
    const d = new Date(Date.UTC(year, month, day, lh, 0, 0));
    d.setUTCHours(d.getUTCHours() - offset);
    return d.toISOString();
  };

  return { window_start: makeUTC(startHour), window_end: makeUTC(endHour) };
}

/**
 * Build the full timezone + language + calling-window enrichment for a lead.
 * lead must have: state, phone (optional), territory_id (optional).
 */
async function enrichLeadTimezone(lead) {
  const timezone = STATE_TIMEZONE[(lead.state || '').toUpperCase()] || 'America/Los_Angeles';

  // Language from area code
  let preferredLanguage  = 'en';
  let languageConfidence = 'low';
  let sophiaVoiceProfile = 'en';

  if (lead.phone) {
    const digits    = lead.phone.replace(/\D/g, '').replace(/^1/, '');
    const areaCode  = digits.slice(0, 3);
    const { data: lp } = await supabase
      .from('language_profiles')
      .select('primary_lang, secondary_lang')
      .eq('area_code', areaCode)
      .maybeSingle();

    if (lp?.primary_lang) {
      preferredLanguage  = lp.primary_lang;
      sophiaVoiceProfile = lp.primary_lang;
      languageConfidence = 'high';
    }
  }

  // Territory calling hours override FCC defaults
  let startHour = FCC_START;
  let endHour   = FCC_END;

  if (lead.territory_id) {
    const { data: t } = await supabase
      .from('territories')
      .select('calling_start_local, calling_end_local')
      .eq('id', lead.territory_id)
      .maybeSingle();

    if (t?.calling_start_local) {
      startHour = parseInt(t.calling_start_local.split(':')[0]);
      endHour   = parseInt(t.calling_end_local.split(':')[0]);
    }
  }

  const { window_start, window_end } = computeCallingWindow(timezone, startHour, endHour);

  return {
    timezone,
    preferred_language:   preferredLanguage,
    language_confidence:  languageConfidence,
    sophia_voice_profile: sophiaVoiceProfile,
    calling_window_start: window_start,
    calling_window_end:   window_end,
  };
}

/**
 * Returns true if NOW (UTC) is inside this lead's calling window.
 * Falls back to state-TZ + FCC defaults when the lead has no stored window.
 */
function isWithinCallingWindow(lead) {
  const now = new Date();

  if (lead.calling_window_start && lead.calling_window_end) {
    return now >= new Date(lead.calling_window_start) && now <= new Date(lead.calling_window_end);
  }

  // Fallback: derive from state timezone
  const timezone = STATE_TIMEZONE[(lead.state || '').toUpperCase()] || 'America/Los_Angeles';
  const { window_start, window_end } = computeCallingWindow(timezone);
  return now >= new Date(window_start) && now <= new Date(window_end);
}

module.exports = { STATE_TIMEZONE, computeCallingWindow, enrichLeadTimezone, isWithinCallingWindow };
